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
import { returnSourceBindingKey } from '../../src/domain/refund-prior-returns.ts';
import type { PaymentReturnEvidence } from '../../src/domain/refund-prior-returns.ts';

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });
const COLLECT_ID = 'collect-1';
const REFUND_ID = 'refund-1';
const GATEWAY_AUTHORITY = 'authority-gateway';
const GATEWAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

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
  correctionEffect: overrides.correctionEffect,
  correctsObservationId: overrides.correctsObservationId,
  economicEffectKey: overrides.economicEffectKey,
  factKind: overrides.factKind ?? 'COLLECTION_CONFIRMED',
  observationId,
  operationId: overrides.operationId ?? COLLECT_ID,
  source: overrides.source ?? GATEWAY_SOURCE,
  sourceAuthorityId: overrides.sourceAuthorityId ?? GATEWAY_AUTHORITY,
});

const observed = (overrides: Partial<QualifiedPaymentObservation>): QualifiedPaymentObservation => ({
  amount: overrides.amount,
  correctsObservationId: overrides.correctsObservationId,
  economicEffectKey: overrides.economicEffectKey,
  factKind: overrides.factKind ?? 'COLLECTION_CONFIRMED',
  operationId: overrides.operationId ?? COLLECT_ID,
  source: overrides.source ?? GATEWAY_SOURCE,
  sourceAuthorityId: overrides.sourceAuthorityId ?? GATEWAY_AUTHORITY,
});
/** Evidence whose source could not prove an exact operation correlation. */
const uncorrelated = (): QualifiedPaymentObservation => {
  const { operationId: _correlated, ...rest } = observed({});
  return { ...rest, operationId: Option.getOrUndefined(Option.none<string>()) };
};

/** One prior return statement as the funds reader loads it; statements share one source-scoped effect. */
const priorReturn = (observationId: string, operationId: string, amountMinor: number): PaymentReturnEvidence => ({
  amount: czk(amountMinor),
  economicEffectKey: 'gopay:refund:prior',
  observationId,
  operationId,
  sourceBindingKey: 'gateway-binding',
});

const aggregateOf = (
  operations: readonly PaymentEvidenceOperationView[],
  acceptedObservations: readonly PaymentAcceptedObservationView[] = [],
  attachedStatements: readonly PaymentAcceptedObservationView[] = [],
): PaymentEvidenceAggregate => ({ acceptedObservations, attachedStatements, operations });

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

  it('#1151 a proven different economic effect on a collection established by governed attachment is held, not counted once', () => {
    const attachedCharge = accepted('obs-attached', { economicEffectKey: 'charge-a', operationId: COLLECT_ID });
    const decision = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED')], [], [attachedCharge]),
      observed({ economicEffectKey: 'charge-b' }),
    );
    expect(decision).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'DISTINCT_ECONOMIC_EFFECT' }),
    );
    // The attached charge itself, restated, still counts once.
    expect(
      interpretPaymentObservation(
        aggregateOf([operation('EFFECT_CONFIRMED')], [], [attachedCharge]),
        observed({ economicEffectKey: 'charge-a' }),
      ),
    ).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'CORROBORATES_ESTABLISHED_OUTCOME' }),
    );
  });

  it('#1151 an economic effect that confirmed one refund is held when it is correlated to another refund', () => {
    const refund = (operationId: string, outcome: PaymentOperationOutcome) =>
      operation(outcome, { amount: czk(10_000), kind: 'REFUND', operationId });
    const confirmedFirst = accepted('obs-refund-1', {
      amount: czk(10_000),
      economicEffectKey: 'gopay:refund:1',
      factKind: 'REFUND_CONFIRMED',
      operationId: 'refund-a',
    });
    const sameEffect = observed({
      amount: czk(10_000),
      economicEffectKey: 'gopay:refund:1',
      factKind: 'REFUND_CONFIRMED',
      operationId: 'refund-b',
    });
    const operations = [refund('refund-a', 'EFFECT_CONFIRMED'), refund('refund-b', 'PENDING')];
    expect(interpretPaymentObservation(aggregateOf(operations, [confirmedFirst]), sameEffect)).toEqual(
      PaymentEvidenceDecision.HOLD({
        operationId: 'refund-b',
        reason: 'ECONOMIC_EFFECT_ESTABLISHED_ANOTHER_OPERATION',
      }),
    );
    // A held statement governance attached to the first refund established it just the same.
    expect(interpretPaymentObservation(aggregateOf(operations, [], [confirmedFirst]), sameEffect)).toEqual(
      PaymentEvidenceDecision.HOLD({
        operationId: 'refund-b',
        reason: 'ECONOMIC_EFFECT_ESTABLISHED_ANOTHER_OPERATION',
      }),
    );
    // A disproven statement no longer establishes the first refund: the effect may confirm the second.
    const correction = accepted('obs-correction', {
      correctsObservationId: 'obs-refund-1',
      factKind: 'SOURCE_CORRECTION',
      operationId: 'refund-a',
    });
    expect(
      PaymentEvidenceDecision.$is('TRANSITION')(
        interpretPaymentObservation(aggregateOf(operations, [confirmedFirst, correction]), sameEffect),
      ),
    ).toBe(true);
  });

  it('#1151 an economic effect key of another source binding is not the same economic effect', () => {
    const refund = (operationId: string, outcome: PaymentOperationOutcome) =>
      operation(outcome, { amount: czk(10_000), kind: 'REFUND', operationId });
    const confirmedFirst = accepted('obs-refund-1', {
      amount: czk(10_000),
      economicEffectKey: 'refund:1',
      factKind: 'REFUND_CONFIRMED',
      operationId: 'refund-a',
      source: {
        accountRef: 'erp-bank-1',
        environment: 'production',
        sourceKind: 'BANK_ACCOUNTING',
        sourceSystem: 'ERP',
      },
      sourceAuthorityId: 'authority-bank',
    });
    const otherSource = observed({
      amount: czk(10_000),
      economicEffectKey: 'refund:1',
      factKind: 'REFUND_CONFIRMED',
      operationId: 'refund-b',
    });
    const operations = [refund('refund-a', 'EFFECT_CONFIRMED'), refund('refund-b', 'PENDING')];
    expect(interpretPaymentObservation(aggregateOf(operations, [confirmedFirst]), otherSource)).toEqual(
      PaymentEvidenceDecision.TRANSITION({
        expectedOutcomeRevision: 2,
        from: 'PENDING',
        operationId: 'refund-b',
        to: 'EFFECT_CONFIRMED',
      }),
    );
  });

  it('#1151 one source binding is one economic effect namespace across its method-neutral and method-specific authorities', () => {
    const refund = (operationId: string, outcome: PaymentOperationOutcome) =>
      operation(outcome, { amount: czk(10_000), kind: 'REFUND', operationId });
    const confirmedFirst = accepted('obs-refund-1', {
      amount: czk(10_000),
      economicEffectKey: 'gopay:refund:1',
      factKind: 'REFUND_CONFIRMED',
      operationId: 'refund-a',
      sourceAuthorityId: 'authority-gateway-method-neutral',
    });
    const sameSourceOtherAuthority = observed({
      amount: czk(10_000),
      economicEffectKey: 'gopay:refund:1',
      factKind: 'REFUND_CONFIRMED',
      operationId: 'refund-b',
      sourceAuthorityId: 'authority-gateway-online',
    });
    const operations = [refund('refund-a', 'EFFECT_CONFIRMED'), refund('refund-b', 'PENDING')];
    const heldForB = PaymentEvidenceDecision.HOLD({
      operationId: 'refund-b',
      reason: 'ECONOMIC_EFFECT_ESTABLISHED_ANOTHER_OPERATION',
    });
    expect(interpretPaymentObservation(aggregateOf(operations, [confirmedFirst]), sameSourceOtherAuthority)).toEqual(
      heldForB,
    );
    // A governed attachment of a statement qualified by the other authority record establishes it the same.
    expect(
      interpretPaymentObservation(aggregateOf(operations, [], [confirmedFirst]), sameSourceOtherAuthority),
    ).toEqual(heldForB);
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

  it('#1151 a correction against governed-attached corroboration is held exactly like accepted corroboration', () => {
    const correctReceipt = (aggregate: PaymentEvidenceAggregate) =>
      interpretPaymentObservation(
        aggregate,
        observed({ amount: czk(30_000), correctsObservationId: 'obs-receipt', factKind: 'SOURCE_CORRECTION' }),
      );
    const held = PaymentEvidenceDecision.HOLD({
      operationId: COLLECT_ID,
      reason: 'CORRECTION_CONTRADICTS_CORROBORATING_EVIDENCE',
    });
    const receipt = accepted('obs-receipt');
    const corroboration = accepted('obs-lookup');
    expect(correctReceipt(aggregateOf([operation('EFFECT_CONFIRMED')], [receipt, corroboration]))).toEqual(held);
    // A held statement a governed ATTACH_EVIDENCE counted toward the collection corroborates it the same.
    expect(correctReceipt(aggregateOf([operation('EFFECT_CONFIRMED')], [receipt], [corroboration]))).toEqual(held);
    // A statement attached to another operation does not corroborate this collection.
    expect(
      correctReceipt(
        aggregateOf([operation('EFFECT_CONFIRMED')], [receipt], [accepted('obs-lookup', { operationId: 'collect-2' })]),
      ),
    ).toEqual(
      PaymentEvidenceDecision.CORRECTION({
        affectedOperationId: COLLECT_ID,
        correctedObservationId: 'obs-receipt',
        effect: PaymentCorrectionEffect.REDUCE_ESTABLISHED_COLLECTION({ amount: czk(30_000) }),
      }),
    );
  });

  it('#1151 a partially corrected receipt still identifies its economic effect: a second charge is held', () => {
    const partiallyCorrected = aggregateOf(
      [operation('EFFECT_CONFIRMED')],
      [
        accepted('obs-charge-1', { economicEffectKey: 'gopay:charge:1' }),
        accepted('obs-partial-correction', {
          amount: czk(30_000),
          correctsObservationId: 'obs-charge-1',
          economicEffectKey: 'gopay:charge:1:correction',
          factKind: 'SOURCE_CORRECTION',
        }),
      ],
    );
    expect(interpretPaymentObservation(partiallyCorrected, observed({ economicEffectKey: 'gopay:charge:2' }))).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'DISTINCT_ECONOMIC_EFFECT' }),
    );
    // Restating the partially corrected charge itself still corroborates.
    expect(interpretPaymentObservation(partiallyCorrected, observed({ economicEffectKey: 'gopay:charge:1' }))).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'CORROBORATES_ESTABLISHED_OUTCOME' }),
    );
  });

  it('#1151 retracting an applied correction is held for reconciliation, never recorded without effect', () => {
    const corrected = aggregateOf(
      [operation('EFFECT_CONFIRMED')],
      [
        accepted('obs-receipt', { economicEffectKey: 'bank:line:1' }),
        accepted('obs-partial', {
          amount: czk(10_000),
          correctsObservationId: 'obs-receipt',
          economicEffectKey: 'bank:line:1:correction',
          factKind: 'SOURCE_CORRECTION',
        }),
      ],
    );
    expect(
      interpretPaymentObservation(
        corrected,
        observed({
          correctsObservationId: 'obs-partial',
          economicEffectKey: 'bank:line:1:correction:retracted',
          factKind: 'SOURCE_CORRECTION',
        }),
      ),
    ).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_OVERLAPS_PRIOR_CORRECTION' }),
    );
  });

  it('#1151 keyed and keyless confirmations are never proven the same money', () => {
    const keyless = aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-keyless')]);
    const keyed = aggregateOf(
      [operation('EFFECT_CONFIRMED')],
      [accepted('obs-keyed', { economicEffectKey: 'charge:1' })],
    );
    const distinct = PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'DISTINCT_ECONOMIC_EFFECT' });
    const corroborates = PaymentEvidenceDecision.NO_CHANGE({
      operationId: COLLECT_ID,
      reason: 'CORROBORATES_ESTABLISHED_OUTCOME',
    });
    expect(interpretPaymentObservation(keyless, observed({ economicEffectKey: 'charge:2' }))).toEqual(distinct);
    expect(interpretPaymentObservation(keyed, observed({}))).toEqual(distinct);
    expect(interpretPaymentObservation(keyless, observed({}))).toEqual(corroborates);
    expect(interpretPaymentObservation(keyed, observed({ economicEffectKey: 'charge:1' }))).toEqual(corroborates);
    // Keys are source-scoped: the same opaque key from another source binding is another receipt.
    const otherBank = {
      accountRef: 'bank-b',
      environment: 'production',
      sourceKind: 'BANK_ACCOUNTING',
      sourceSystem: 'ERP',
    } as const;
    expect(interpretPaymentObservation(keyed, observed({ economicEffectKey: 'charge:1', source: otherBank }))).toEqual(
      distinct,
    );
  });

  it('#1150 a confirmed cancellation and a confirmed collection of one COLLECT open a conflict, never a silent hold', () => {
    const cancel = (outcome: PaymentOperationOutcome) =>
      operation(outcome, { kind: 'CANCEL_OR_VOID', operationId: 'cancel-1', targetOperationId: COLLECT_ID });
    // The cancellation is confirmed first, then the collection is reported as collected.
    const lateCollection = interpretPaymentObservation(
      aggregateOf([operation('PENDING'), cancel('EFFECT_CONFIRMED')]),
      observed({ amount: czk(100_000) }),
    );
    expect(PaymentEvidenceDecision.$is('CONFLICT')(lateCollection)).toBe(true);
    // The collection is proven first, then the cancellation is reported as confirmed.
    const lateCancel = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED'), cancel('PENDING')]),
      observed({ factKind: 'CANCEL_CONFIRMED', operationId: 'cancel-1' }),
    );
    expect(PaymentEvidenceDecision.$is('CONFLICT')(lateCancel)).toBe(true);
    // A cancellation that is only pending does not contradict a collection yet.
    const collectionWhileCancelPending = interpretPaymentObservation(
      aggregateOf([operation('PENDING'), cancel('PENDING')]),
      observed({ amount: czk(100_000) }),
    );
    expect(PaymentEvidenceDecision.$is('TRANSITION')(collectionWhileCancelPending)).toBe(true);
  });

  it('#1151 a partial correction below the confirmed and reserved returns is held, never applied silently', () => {
    const refund = (outcome: PaymentOperationOutcome) =>
      operation(outcome, {
        amount: czk(80_000),
        kind: 'REFUND',
        operationId: 'refund-1',
        targetOperationId: COLLECT_ID,
      });
    const correction = observed({
      amount: czk(30_000),
      correctsObservationId: 'obs-receipt',
      factKind: 'SOURCE_CORRECTION',
    });
    for (const outcome of ['EFFECT_CONFIRMED', 'PENDING'] as const) {
      expect(
        interpretPaymentObservation(
          aggregateOf([operation('EFFECT_CONFIRMED'), refund(outcome)], [accepted('obs-receipt')]),
          correction,
        ),
      ).toEqual(
        PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_EXCEEDS_REMAINING_FUNDS' }),
      );
    }
    // A reduction of a receipt that was fully disproven (and replaced) no longer counts against the funds.
    const withRetiredReduction = (fullyDisprovenObservationIds: ReadonlySet<string>) =>
      interpretPaymentObservation(
        {
          ...aggregateOf(
            [operation('EFFECT_CONFIRMED'), refund('EFFECT_CONFIRMED')],
            [
              accepted('obs-retired'),
              accepted('obs-retired-reduction', {
                amount: czk(10_000),
                correctionEffect: 'REDUCE_ESTABLISHED_COLLECTION',
                correctsObservationId: 'obs-retired',
                factKind: 'SOURCE_CORRECTION',
              }),
              accepted('obs-receipt'),
            ],
          ),
          fullyDisprovenObservationIds,
        },
        { ...correction, amount: czk(15_000) },
      );
    expect(PaymentEvidenceDecision.$is('HOLD')(withRetiredReduction(new Set()))).toBe(true);
    expect(PaymentEvidenceDecision.$is('HOLD')(withRetiredReduction(new Set(['obs-retired'])))).toBe(false);
    // A return stated against the collection itself (a prior return the funds reader counts) holds it too.
    const withPriorReturn = (amountMinor: number) =>
      interpretPaymentObservation(
        {
          ...aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-receipt')]),
          returnEvidence: [priorReturn('obs-return', COLLECT_ID, amountMinor)],
        },
        { ...correction, amount: czk(20_000) },
      );
    expect(withPriorReturn(90_000)).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_EXCEEDS_REMAINING_FUNDS' }),
    );
    expect(PaymentEvidenceDecision.$is('CORRECTION')(withPriorReturn(80_000))).toBe(true);
    // A prior return counts for what it still proves after its own partial corrections.
    const correctedReturn = interpretPaymentObservation(
      {
        ...aggregateOf([operation('EFFECT_CONFIRMED')], [accepted('obs-receipt')]),
        returnEvidence: [{ ...priorReturn('obs-return', COLLECT_ID, 90_000), correctedAmount: czk(20_000) }],
      },
      { ...correction, amount: czk(20_000) },
    );
    expect(PaymentEvidenceDecision.$is('CORRECTION')(correctedReturn)).toBe(true);
    // One return first stated against the collection and later against its REFUND is one return: the
    // counted REFUND stands for it, so a 100 CZK reduction of a 1000 CZK collection with 600 CZK returned applies.
    const restatedAgainstRefund = interpretPaymentObservation(
      {
        ...aggregateOf(
          [
            operation('EFFECT_CONFIRMED'),
            operation('EFFECT_CONFIRMED', {
              amount: czk(60_000),
              kind: 'REFUND',
              operationId: REFUND_ID,
              targetOperationId: COLLECT_ID,
            }),
          ],
          [accepted('obs-receipt')],
        ),
        returnEvidence: [
          priorReturn('obs-return-collect', COLLECT_ID, 60_000),
          priorReturn('obs-return-refund', REFUND_ID, 60_000),
        ],
      },
      { ...correction, amount: czk(10_000) },
    );
    expect(PaymentEvidenceDecision.$is('CORRECTION')(restatedAgainstRefund)).toBe(true);
    // A return statement recorded against the collection is not a second receipt of that collection.
    const withReturnOnCollect = interpretPaymentObservation(
      aggregateOf(
        [operation('EFFECT_CONFIRMED')],
        [accepted('obs-receipt'), accepted('obs-return-on-collect', { factKind: 'REFUND_CONFIRMED' })],
      ),
      { ...correction, amount: czk(10_000) },
    );
    expect(PaymentEvidenceDecision.$is('CORRECTION')(withReturnOnCollect)).toBe(true);
    // A correction that was only recorded (for example of a pending statement) reduced nothing.
    const afterRecordOnly = interpretPaymentObservation(
      aggregateOf(
        [operation('EFFECT_CONFIRMED')],
        [
          accepted('obs-pending', { factKind: 'COLLECTION_PENDING' }),
          accepted('obs-pending-correction', {
            amount: czk(10_000),
            correctionEffect: 'RECORD_ONLY',
            correctsObservationId: 'obs-pending',
            factKind: 'SOURCE_CORRECTION',
          }),
          accepted('obs-receipt'),
        ],
      ),
      { ...correction, amount: czk(95_000) },
    );
    expect(PaymentEvidenceDecision.$is('CORRECTION')(afterRecordOnly)).toBe(true);
    // A refund proven not effected reserves nothing: the reduction applies.
    const applied = interpretPaymentObservation(
      aggregateOf([operation('EFFECT_CONFIRMED'), refund('NOT_EFFECTED_CONFIRMED')], [accepted('obs-receipt')]),
      correction,
    );
    expect(PaymentEvidenceDecision.$is('CORRECTION')(applied)).toBe(true);
  });

  it('#1151 a fully disproven receipt no longer identifies the collection its replacement established', () => {
    // Charge 1 was reduced, then fully retracted (the retraction is held); charge 2 was attached instead.
    const replaced = {
      ...aggregateOf(
        [operation('EFFECT_CONFIRMED')],
        [
          accepted('obs-charge-1', { economicEffectKey: 'gopay:charge:1' }),
          accepted('obs-charge-1-reduction', {
            amount: czk(10_000),
            correctsObservationId: 'obs-charge-1',
            economicEffectKey: 'gopay:charge:1:reduction',
            factKind: 'SOURCE_CORRECTION',
          }),
        ],
        [accepted('obs-charge-2', { economicEffectKey: 'gopay:charge:2' })],
      ),
      fullyDisprovenObservationIds: new Set(['obs-charge-1']),
    };
    // A new confirmation of the retracted charge 1 is a charge distinct from the replacement: held.
    expect(interpretPaymentObservation(replaced, observed({ economicEffectKey: 'gopay:charge:1' }))).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'DISTINCT_ECONOMIC_EFFECT' }),
    );
    // Restating the replacement still corroborates.
    expect(interpretPaymentObservation(replaced, observed({ economicEffectKey: 'gopay:charge:2' }))).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'CORROBORATES_ESTABLISHED_OUTCOME' }),
    );
  });

  it('#1151 a confirmation of a collection whose every receipt was disproven is a separate charge, never corroboration', () => {
    // Charge 1 was reduced and then fully retracted (the retraction is held): nothing standing confirms it.
    const allDisproven = {
      ...aggregateOf(
        [operation('EFFECT_CONFIRMED')],
        [
          accepted('obs-charge-1', { economicEffectKey: 'gopay:charge:1' }),
          accepted('obs-charge-1-reduction', {
            amount: czk(60_000),
            correctionEffect: 'REDUCE_ESTABLISHED_COLLECTION',
            correctsObservationId: 'obs-charge-1',
            factKind: 'SOURCE_CORRECTION',
          }),
        ],
      ),
      fullyDisprovenObservationIds: new Set(['obs-charge-1']),
    };
    expect(interpretPaymentObservation(allDisproven, observed({ economicEffectKey: 'gopay:charge:2' }))).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'DISTINCT_ECONOMIC_EFFECT' }),
    );
    // Once the retracted collection is resolved as not effected, a further statement of that
    // non-execution only corroborates it: the disproven receipt opens no new debt.
    expect(
      interpretPaymentObservation(
        { ...allDisproven, operations: [operation('NOT_EFFECTED_CONFIRMED')] },
        observed({ amount: czk(100_000), factKind: 'COLLECTION_NOT_EFFECTED' }),
      ),
    ).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'CORROBORATES_ESTABLISHED_OUTCOME' }),
    );
    // An operation confirmed without any recorded statement still accepts its first confirmation.
    expect(
      interpretPaymentObservation(
        aggregateOf([operation('EFFECT_CONFIRMED')]),
        observed({ economicEffectKey: 'gopay:charge:1' }),
      ),
    ).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'CORROBORATES_ESTABLISHED_OUTCOME' }),
    );
  });

  it('#1150 a not-effected statement about other money than the operation never releases it', () => {
    const pendingRefund = operation('PENDING', { amount: czk(10_000), kind: 'REFUND', operationId: 'refund-1' });
    const notEffected = (amountMinor: number) =>
      interpretPaymentObservation(
        aggregateOf([operation('EFFECT_CONFIRMED'), pendingRefund]),
        observed({ amount: czk(amountMinor), factKind: 'REFUND_NOT_EFFECTED', operationId: 'refund-1' }),
      );
    expect(PaymentEvidenceDecision.$is('CONFLICT')(notEffected(40_000))).toBe(true);
    expect(PaymentEvidenceDecision.$is('TRANSITION')(notEffected(10_000))).toBe(true);
  });

  it('#1151 a re-issued correction of a re-exported statement counts once; an overlapping one is held', () => {
    const correctedReceipt = aggregateOf(
      [operation('EFFECT_CONFIRMED')],
      [
        accepted('obs-receipt-a', { economicEffectKey: 'bank:line:1' }),
        accepted('obs-correction-a', {
          amount: czk(30_000),
          correctsObservationId: 'obs-receipt-a',
          economicEffectKey: 'bank:line:1:correction',
          factKind: 'SOURCE_CORRECTION',
        }),
        accepted('obs-receipt-b', { economicEffectKey: 'bank:line:1' }),
      ],
    );
    const correctionOfReExport = (economicEffectKey: string | undefined) =>
      interpretPaymentObservation(
        correctedReceipt,
        observed({
          amount: czk(30_000),
          correctsObservationId: 'obs-receipt-b',
          economicEffectKey,
          factKind: 'SOURCE_CORRECTION',
        }),
      );
    expect(correctionOfReExport('bank:line:1:correction')).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'ALREADY_CORRECTED' }),
    );
    for (const key of ['bank:line:1:correction-2', undefined]) {
      expect(correctionOfReExport(key)).toEqual(
        PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_OVERLAPS_PRIOR_CORRECTION' }),
      );
    }
  });

  it('#1151 a correction key reused against a different receipt is held, never read as a re-issue', () => {
    // Charge 1 was fully retracted; charge 2 is another receipt of the same COLLECT.
    const replaced = aggregateOf(
      [operation('EFFECT_CONFIRMED')],
      [
        accepted('obs-charge-1', { economicEffectKey: 'gopay:charge:1' }),
        accepted('obs-retraction-1', {
          correctsObservationId: 'obs-charge-1',
          economicEffectKey: 'gopay:retraction:1',
          factKind: 'SOURCE_CORRECTION',
        }),
        accepted('obs-charge-2', { economicEffectKey: 'gopay:charge:2' }),
      ],
    );
    expect(
      interpretPaymentObservation(
        replaced,
        observed({
          amount: czk(100_000),
          correctsObservationId: 'obs-charge-2',
          economicEffectKey: 'gopay:retraction:1',
          factKind: 'SOURCE_CORRECTION',
        }),
      ),
    ).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_OVERLAPS_PRIOR_CORRECTION' }),
    );
  });

  it('#1151 a further correction of an already partially corrected statement is held, never deduplicated', () => {
    const partiallyCorrected = aggregateOf(
      [operation('EFFECT_CONFIRMED', { amount: czk(10_000) })],
      [
        accepted('obs-receipt', { amount: czk(10_000), economicEffectKey: 'bank:line:1' }),
        accepted('obs-correction', {
          amount: czk(1000),
          correctsObservationId: 'obs-receipt',
          economicEffectKey: 'bank:line:1:correction',
          factKind: 'SOURCE_CORRECTION',
        }),
      ],
    );
    const correctReceipt = (economicEffectKey: string | undefined, amount = czk(10_000)) =>
      interpretPaymentObservation(
        partiallyCorrected,
        observed({ amount, correctsObservationId: 'obs-receipt', economicEffectKey, factKind: 'SOURCE_CORRECTION' }),
      );
    // Only a proven re-issue of the same correction (same source binding and correction key) counts once.
    expect(correctReceipt('bank:line:1:correction', czk(1000))).toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'ALREADY_CORRECTED' }),
    );
    // A full retraction under another key, or one that cannot prove its key, is a new disproof to reconcile.
    for (const key of ['bank:line:1:retraction', undefined]) {
      expect(correctReceipt(key)).toEqual(
        PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_OVERLAPS_PRIOR_CORRECTION' }),
      );
    }
    // The same correction key from another source binding is not a proven re-issue either.
    expect(
      interpretPaymentObservation(
        partiallyCorrected,
        observed({
          amount: czk(1000),
          correctsObservationId: 'obs-receipt',
          economicEffectKey: 'bank:line:1:correction',
          factKind: 'SOURCE_CORRECTION',
          source: { ...GATEWAY_SOURCE, accountRef: 'gopay-account-2' },
        }),
      ),
    ).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_OVERLAPS_PRIOR_CORRECTION' }),
    );
  });

  it('#1151 a correction key is scoped to its source binding: another source retracting its receipt is applied', () => {
    const bankSource = {
      accountRef: 'erp-bank-1',
      environment: 'production',
      sourceKind: 'BANK_ACCOUNTING',
      sourceSystem: 'ERP',
    } as const;
    const aggregate = aggregateOf(
      [operation('EFFECT_CONFIRMED')],
      [
        accepted('obs-bank-receipt', { economicEffectKey: 'line:1', source: bankSource }),
        accepted('obs-bank-correction', {
          amount: czk(30_000),
          correctsObservationId: 'obs-bank-receipt',
          economicEffectKey: 'retraction:1',
          factKind: 'SOURCE_CORRECTION',
          source: bankSource,
        }),
        accepted('obs-gateway-receipt', { economicEffectKey: 'line:1' }),
      ],
    );
    const gatewayRetraction = interpretPaymentObservation(
      aggregate,
      observed({
        amount: czk(30_000),
        correctsObservationId: 'obs-gateway-receipt',
        economicEffectKey: 'retraction:1',
        factKind: 'SOURCE_CORRECTION',
      }),
    );
    expect(gatewayRetraction).not.toEqual(
      PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'ALREADY_CORRECTED' }),
    );
    expect(gatewayRetraction).not.toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_OVERLAPS_PRIOR_CORRECTION' }),
    );
  });

  it('#1151 a correction of governed-attached evidence is applied like one of accepted evidence', () => {
    const attachedOnly = aggregateOf(
      [operation('EFFECT_CONFIRMED')],
      [],
      [accepted('obs-attached-receipt', { economicEffectKey: 'gopay:payment:1' })],
    );
    const acceptedOnly = aggregateOf(
      [operation('EFFECT_CONFIRMED')],
      [accepted('obs-attached-receipt', { economicEffectKey: 'gopay:payment:1' })],
    );
    // The source names only the corrected statement, not its operation.
    const fullRetraction = {
      ...uncorrelated(),
      correctsObservationId: 'obs-attached-receipt',
      factKind: 'SOURCE_CORRECTION' as const,
    };
    const partialCorrection = { ...fullRetraction, amount: czk(10_000) };
    for (const correction of [fullRetraction, partialCorrection]) {
      const decision = interpretPaymentObservation(attachedOnly, correction);
      expect(PaymentEvidenceDecision.$is('CORRECTION')(decision)).toBe(true);
      expect(decision).toEqual(interpretPaymentObservation(acceptedOnly, correction));
    }
  });

  it('#1151 corrections: already corrected, unknown target and lineage mismatch', () => {
    const correctedOnce = aggregateOf(
      [operation('CONFLICT')],
      [
        accepted('obs-receipt'),
        accepted('obs-correction', {
          correctsObservationId: 'obs-receipt',
          economicEffectKey: 'retraction:1',
          factKind: 'SOURCE_CORRECTION',
        }),
      ],
    );
    expect(
      interpretPaymentObservation(
        correctedOnce,
        observed({
          amount: czk(100_000),
          correctsObservationId: 'obs-receipt',
          economicEffectKey: 'retraction:1',
          factKind: 'SOURCE_CORRECTION',
        }),
      ),
    ).toEqual(PaymentEvidenceDecision.NO_CHANGE({ operationId: COLLECT_ID, reason: 'ALREADY_CORRECTED' }));
    // The same key re-issued at another amount is a different claim: held, never deduplicated.
    expect(
      interpretPaymentObservation(
        correctedOnce,
        observed({
          amount: czk(40_000),
          correctsObservationId: 'obs-receipt',
          economicEffectKey: 'retraction:1',
          factKind: 'SOURCE_CORRECTION',
        }),
      ),
    ).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_OVERLAPS_PRIOR_CORRECTION' }),
    );
    expect(
      interpretPaymentObservation(
        aggregateOf([operation('EFFECT_CONFIRMED')]),
        observed({ correctsObservationId: 'missing', factKind: 'SOURCE_CORRECTION' }),
      ),
    ).toEqual(PaymentEvidenceDecision.HOLD({ operationId: COLLECT_ID, reason: 'CORRECTION_TARGET_UNKNOWN' }));
    // A held return counted against the collection is a correction target: the correction is recorded
    // (the funds reader then reduces that return) and the collection's outcome does not change.
    const heldReturn = (operationId: string) => ({
      ...aggregateOf([
        operation('EFFECT_CONFIRMED'),
        operation('EFFECT_CONFIRMED', { kind: 'REFUND', operationId: REFUND_ID, targetOperationId: COLLECT_ID }),
      ]),
      priorReturnStatements: [accepted('obs-held-return', { factKind: 'REFUND_CONFIRMED', operationId })],
    });
    const returnCorrection = (operationId: string) =>
      interpretPaymentObservation(heldReturn(operationId), {
        ...uncorrelated(),
        amount: czk(10_000),
        correctsObservationId: 'obs-held-return',
        factKind: 'SOURCE_CORRECTION',
      });
    expect(returnCorrection(COLLECT_ID)).toEqual(
      PaymentEvidenceDecision.CORRECTION({
        affectedOperationId: COLLECT_ID,
        correctedObservationId: 'obs-held-return',
        effect: PaymentCorrectionEffect.RECORD_ONLY(),
      }),
    );
    // A held statement about a REFUND established nothing: its correction still has no target.
    expect(PaymentEvidenceDecision.$is('HOLD')(returnCorrection(REFUND_ID))).toBe(true);
    // The same return effect stated with other money confirms nothing: it is held as a distinct claim.
    const pendingRefund = operation('PENDING', {
      amount: czk(40_000),
      kind: 'REFUND',
      operationId: REFUND_ID,
      targetOperationId: COLLECT_ID,
    });
    const restated = (amountMinor: number) =>
      interpretPaymentObservation(
        {
          ...aggregateOf([operation('EFFECT_CONFIRMED'), pendingRefund]),
          returnEvidence: [
            {
              ...priorReturn('obs-return', COLLECT_ID, amountMinor),
              sourceBindingKey: returnSourceBindingKey(GATEWAY_SOURCE),
            },
          ],
        },
        observed({
          amount: czk(40_000),
          economicEffectKey: 'gopay:refund:prior',
          factKind: 'REFUND_CONFIRMED',
          operationId: REFUND_ID,
        }),
      );
    expect(restated(60_000)).toEqual(
      PaymentEvidenceDecision.HOLD({ operationId: REFUND_ID, reason: 'DISTINCT_ECONOMIC_EFFECT' }),
    );
    expect(PaymentEvidenceDecision.$is('TRANSITION')(restated(40_000))).toBe(true);
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
