import { describe, expect, it } from 'effect-rstest';
import { Option } from 'effect';

import type { PaymentOperationKind, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import {
  interpretPaymentObservation,
  PaymentCorrectionEffect,
  PaymentEvidenceDecision,
} from '../../src/domain/evidence-interpretation.ts';
import type {
  PaymentAcceptedObservationView,
  PaymentEvidenceAggregate,
  PaymentEvidenceOperationView,
  QualifiedPaymentObservation,
} from '../../src/domain/evidence-interpretation.ts';

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });
const COLLECT_ID = 'collect-1';
const REFUND_ID = 'refund-1';

const operation = (
  outcome: PaymentOperationOutcome,
  overrides: Partial<PaymentEvidenceOperationView> & { readonly kind?: PaymentOperationKind } = {},
): PaymentEvidenceOperationView => ({
  amount: overrides.amount ?? czk(100_000),
  kind: overrides.kind ?? 'COLLECT',
  operationId: overrides.operationId ?? COLLECT_ID,
  outcome,
  outcomeRevision: overrides.outcomeRevision ?? 2,
  targetOperationId: overrides.targetOperationId,
});

const accepted = (
  observationId: string,
  overrides: Partial<PaymentAcceptedObservationView> = {},
): PaymentAcceptedObservationView => ({
  amount: overrides.amount ?? czk(100_000),
  correctsObservationId: overrides.correctsObservationId,
  economicEffectKey: overrides.economicEffectKey,
  factKind: overrides.factKind ?? 'COLLECTION_CONFIRMED',
  observationId,
  operationId: overrides.operationId ?? COLLECT_ID,
});

const observed = (overrides: Partial<QualifiedPaymentObservation>): QualifiedPaymentObservation => ({
  amount: overrides.amount,
  correctsObservationId: overrides.correctsObservationId,
  economicEffectKey: overrides.economicEffectKey,
  factKind: overrides.factKind ?? 'COLLECTION_CONFIRMED',
  operationId: overrides.operationId ?? COLLECT_ID,
});
/** Evidence whose source could not prove an exact operation correlation. */
const uncorrelated = (): QualifiedPaymentObservation => {
  const { operationId: _correlated, ...rest } = observed({});
  return { ...rest, operationId: Option.getOrUndefined(Option.none<string>()) };
};

const aggregateOf = (
  operations: readonly PaymentEvidenceOperationView[],
  acceptedObservations: readonly PaymentAcceptedObservationView[] = [],
): PaymentEvidenceAggregate => ({ acceptedObservations, operations });

describe('#1151 Payment evidence interpretation', () => {
  it('#1151 Duplicate and corroborating observations describe one effect: a corroborating statement counts once', () => {
    const aggregate = aggregateOf(
      [operation('EFFECT_CONFIRMED')],
      [accepted('obs-provider', { economicEffectKey: 'gopay:payment:42' })],
    );
    const decision = interpretPaymentObservation(
      aggregate,
      observed({ amount: czk(100_000), economicEffectKey: 'gopay:payment:42' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'CORROBORATES_ESTABLISHED_OUTCOME' }),
    );
  });

  it('#1151 a matching amount without a proven effect key restates the outcome and never adds money', () => {
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-1')]),
      observed({ amount: czk(100_000) }),
    );
    expect(PaymentEvidenceDecision.$is('NO_CHANGE')(decision)).toBe(true);
  });

  it('#1151 a proven different economic effect on an established collection is held, not counted once', () => {
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-1', { economicEffectKey: 'charge-a' })]),
      observed({ economicEffectKey: 'charge-b' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'DISTINCT_ECONOMIC_EFFECT' }),
    );
  });

  it('#1151 qualified collection evidence moves a PENDING collection to EFFECT_CONFIRMED with its fence', () => {
    const decision = interpretPaymentObservation(aggregateOf([operation('PENDING')]), observed({}));
    expect(decision).toEqual(
      PaymentEvidenceDecision.TRANSITION({
        expectedOutcomeRevision: 2,
        from: 'PENDING',
        operationId: COLLECT_ID,
        to: 'EFFECT_CONFIRMED',
      }),
    );
  });

  it('#1151 stale PENDING evidence cannot erase confirmed collection', () => {
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')]),
      observed({ factKind: 'COLLECTION_PENDING' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'STALE_WEAKER_EVIDENCE' }),
    );
  });

  it('#1151 arrival order never establishes truth: contradictions in either order become CONFLICT', () => {
    const confirmedThenFailed = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')]),
      observed({ factKind: 'COLLECTION_NOT_EFFECTED' }),
    );
    const failedThenConfirmed = interpretPaymentObservation(
      aggregateOf([operation('NOT_EFFECTED_CONFIRMED')]),
      observed({ factKind: 'COLLECTION_CONFIRMED' }),
    );
    for (const [decision, from] of [
      [confirmedThenFailed, 'EFFECT_CONFIRMED'],
      [failedThenConfirmed, 'NOT_EFFECTED_CONFIRMED'],
    ] as const) {
      expect(decision).toEqual(
        PaymentEvidenceDecision.CONFLICT({
          change: Option.some({ expectedOutcomeRevision: 2, from, operationId: COLLECT_ID, to: 'CONFLICT' }),
          operationId: COLLECT_ID,
          reason: 'CONTRADICTS_DEFINITIVE_OUTCOME',
        }),
      );
    }
  });

  it('#1151 later evidence never resolves a CONFLICT by arrival order; it waits for governed reconciliation', () => {
    const decision = interpretPaymentObservation(aggregateOf([operation('CONFLICT')]), observed({}));
    expect(decision).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'OPERATION_IN_CONFLICT' }),
    );
  });

  it('#1151 Late refund does not erase collection: a confirmed refund is its own REFUND operation effect', () => {
    const refund = operation('PENDING', {
      amount: czk(40_000),
      kind: 'REFUND',
      operationId: REFUND_ID,
      outcomeRevision: 1,
      targetOperationId: COLLECT_ID,
    });
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED'), refund]),
      observed({ amount: czk(40_000), factKind: 'REFUND_CONFIRMED', operationId: REFUND_ID }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.TRANSITION({
        expectedOutcomeRevision: 1,
        from: 'PENDING',
        operationId: REFUND_ID,
        to: 'EFFECT_CONFIRMED',
      }),
    );
  });

  it('#1151 a later refund reported against the collection is never dismissed as stale: it is held debt', () => {
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')]),
      observed({ amount: czk(40_000), factKind: 'REFUND_CONFIRMED' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'UNMATCHED_RETURN_EFFECT' }),
    );
  });

  it('#1151 A source corrects a statement rather than reversing money: the disproven collection reopens to CONFLICT', () => {
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-receipt')]),
      observed({ correctsObservationId: 'obs-receipt', factKind: 'SOURCE_CORRECTION' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.CORRECTION({
        affectedOperationId: COLLECT_ID,
        correctedObservationId: 'obs-receipt',
        effect: PaymentCorrectionEffect.REOPEN_TO_CONFLICT({
          change: { expectedOutcomeRevision: 2, from: 'EFFECT_CONFIRMED', operationId: COLLECT_ID, to: 'CONFLICT' },
        }),
      }),
    );
    // A correction never fabricates a refund: no decision names a REFUND operation or a new amount.
    expect(PaymentEvidenceDecision.$is('TRANSITION')(decision)).toBe(false);
  });

  it('#1151 a partial correction reduces proven collection instead of disproving it', () => {
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-receipt')]),
      observed({ amount: czk(30_000), correctsObservationId: 'obs-receipt', factKind: 'SOURCE_CORRECTION' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.CORRECTION({
        affectedOperationId: COLLECT_ID,
        correctedObservationId: 'obs-receipt',
        effect: PaymentCorrectionEffect.REDUCE_ESTABLISHED_COLLECTION({ amount: czk(30_000) }),
      }),
    );
  });

  it('#1151 correcting a statement that never established the outcome is lineage only', () => {
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-pending', { factKind: 'COLLECTION_PENDING' })]),
      observed({ correctsObservationId: 'obs-pending', factKind: 'SOURCE_CORRECTION' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.CORRECTION({
        affectedOperationId: COLLECT_ID,
        correctedObservationId: 'obs-pending',
        effect: PaymentCorrectionEffect.RECORD_ONLY(),
      }),
    );
  });

  it('#1151 a correction against corroborated evidence is ambiguous and held', () => {
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-callback'), accepted('obs-lookup')]),
      observed({ correctsObservationId: 'obs-callback', factKind: 'SOURCE_CORRECTION' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.HOLD({
        operationId: COLLECT_ID,
        reason: 'CORRECTION_CONTRADICTS_CORROBORATING_EVIDENCE',
      }),
    );
  });

  it('#1151 corrections: already corrected, unknown target and lineage mismatch', () => {
    const correctedOnce = aggregateOf(
      [operation('CONFLICT')],
      [
        accepted('obs-receipt'),
        accepted('obs-correction', { correctsObservationId: 'obs-receipt', factKind: 'SOURCE_CORRECTION' }),
      ],
    );
    expect(
      interpretPaymentObservation(
        correctedOnce,
        observed({ correctsObservationId: 'obs-receipt', factKind: 'SOURCE_CORRECTION' }),
      ),
    ).toEqual(PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'ALREADY_CORRECTED' }));
    expect(
      interpretPaymentObservation(
        aggregateOf([operation('EFFECT_CONFIRMED')]),
        observed({ correctsObservationId: 'missing', factKind: 'SOURCE_CORRECTION' }),
      ),
    ).toEqual(PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_TARGET_UNKNOWN' }));
    expect(
      interpretPaymentObservation(
        aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-receipt')]),
        observed({ correctsObservationId: 'obs-receipt', factKind: 'SOURCE_CORRECTION', operationId: 'other' }),
      ),
    ).toEqual(
      PaymentEvidenceDecision.CONFLICT({
        change: Option.none(),
        operationId: COLLECT_ID,
        reason: 'CORRECTION_LINEAGE_MISMATCH',
      }),
    );
  });

  it('#1151 ambiguous, unassignable or unrecognized evidence becomes HOLD, never a first-match guess', () => {
    const aggregate = aggregateOf([operation('PENDING')]);
    expect(interpretPaymentObservation(aggregate, uncorrelated())).toMatchObject({ reason: 'UNCORRELATED_OPERATION' });
    expect(interpretPaymentObservation(aggregate, observed({ operationId: 'foreign' }))).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: 'foreign', reason: 'OPERATION_NOT_IN_PAYMENT' }),
    );
    expect(interpretPaymentObservation(aggregate, observed({ factKind: 'UNRECOGNIZED' }))).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'UNRECOGNIZED_FACT' }),
    );
    expect(interpretPaymentObservation(aggregate, observed({ factKind: 'CANCEL_CONFIRMED' }))).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'FACT_DOES_NOT_MATCH_OPERATION_KIND' }),
    );
  });

  it('#1151 settlement is evidence only and an amount mismatch is a conflict, never a partial success', () => {
    const aggregate = aggregateOf([operation('PENDING')]);
    expect(interpretPaymentObservation(aggregate, observed({ factKind: 'SETTLEMENT_OBSERVED' }))).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'SETTLEMENT_EVIDENCE_ONLY' }),
    );
    expect(interpretPaymentObservation(aggregate, observed({ amount: czk(80_000) }))).toEqual(
      PaymentEvidenceDecision.CONFLICT({
        change: Option.some({ expectedOutcomeRevision: 2, from: 'PENDING', operationId: COLLECT_ID, to: 'CONFLICT' }),
        operationId: COLLECT_ID,
        reason: 'AMOUNT_MISMATCH',
      }),
    );
  });

  it('#1151 Lost create response does not authorize another charge: INDETERMINATE accepts later pending evidence', () => {
    const decision = interpretPaymentObservation(
      aggregateOf([operation('INDETERMINATE')]),
      observed({ factKind: 'COLLECTION_PENDING' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.TRANSITION({
        expectedOutcomeRevision: 2,
        from: 'INDETERMINATE',
        operationId: COLLECT_ID,
        to: 'PENDING',
      }),
    );
  });

  it('#1151 interpretation is independent of the order accepted evidence was stored', () => {
    const confirmed = accepted('obs-a', { economicEffectKey: 'k' });
    const pending = accepted('obs-b', { economicEffectKey: 'k', factKind: 'COLLECTION_PENDING' });
    const forward = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')], [confirmed, pending]),
      observed({ economicEffectKey: 'k' }),
    );
    const reversed = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')], [pending, confirmed]),
      observed({ economicEffectKey: 'k' }),
    );
    expect(forward).toEqual(reversed);
  });
});
