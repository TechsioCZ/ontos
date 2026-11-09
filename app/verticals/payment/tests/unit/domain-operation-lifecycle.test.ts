import { describe, expect, it } from 'effect-rstest';
import { Array as EffectArray, Order } from 'effect';

import { PAYMENT_OPERATION_OUTCOMES } from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import {
  decideOperationAdmission,
  decideOutcomeTransition,
  isAllowedOutcomeTransition,
  isDefinitiveOutcome,
  isUnresolvedOutcome,
  OperationAdmissionDecision,
  OutcomeTransitionDecision,
  PAYMENT_OUTCOME_TRANSITIONS,
  releasesReservations,
} from '../../src/domain/operation-lifecycle.ts';
import type { PaymentOperationIdentityView } from '../../src/domain/operation-lifecycle.ts';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const collect = (operationId: string, outcome: PaymentOperationOutcome, operationKey = operationId) =>
  ({ kind: 'COLLECT', materialHash: hashA, operationId, operationKey, outcome }) satisfies PaymentOperationIdentityView;

describe('#1148 Payment Operation outcome lifecycle', () => {
  it('allows exactly the canonical transition table', () => {
    const allowed = PAYMENT_OPERATION_OUTCOMES.flatMap((from) =>
      PAYMENT_OPERATION_OUTCOMES.filter((to) => isAllowedOutcomeTransition(from, to)).map((to) => `${from}->${to}`),
    );

    expect(allowed).toEqual([
      'PENDING->EFFECT_CONFIRMED',
      'PENDING->NOT_EFFECTED_CONFIRMED',
      'PENDING->INDETERMINATE',
      'PENDING->CONFLICT',
      'EFFECT_CONFIRMED->CONFLICT',
      'NOT_EFFECTED_CONFIRMED->CONFLICT',
      'INDETERMINATE->PENDING',
      'INDETERMINATE->EFFECT_CONFIRMED',
      'INDETERMINATE->NOT_EFFECTED_CONFIRMED',
      'INDETERMINATE->CONFLICT',
      'CONFLICT->EFFECT_CONFIRMED',
      'CONFLICT->NOT_EFFECTED_CONFIRMED',
    ]);
    expect(EffectArray.sort(Object.keys(PAYMENT_OUTCOME_TRANSITIONS), Order.String)).toEqual(
      EffectArray.sort(PAYMENT_OPERATION_OUTCOMES, Order.String),
    );
  });

  it('#1151 stale pending evidence cannot erase confirmed collection', () => {
    const decision = decideOutcomeTransition('EFFECT_CONFIRMED', 'PENDING');

    expect(OutcomeTransitionDecision.$is('Stale')(decision)).toBe(true);
    expect(OutcomeTransitionDecision.$is('Stale')(decideOutcomeTransition('EFFECT_CONFIRMED', 'INDETERMINATE'))).toBe(
      true,
    );
    expect(OutcomeTransitionDecision.$is('Stale')(decideOutcomeTransition('CONFLICT', 'PENDING'))).toBe(true);
  });

  it('#1151 contradicting a definitive outcome is a conflict, never a silent flip', () => {
    expect(
      OutcomeTransitionDecision.$is('Contradiction')(
        decideOutcomeTransition('EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED'),
      ),
    ).toBe(true);
    expect(
      OutcomeTransitionDecision.$is('Contradiction')(
        decideOutcomeTransition('NOT_EFFECTED_CONFIRMED', 'EFFECT_CONFIRMED'),
      ),
    ).toBe(true);
    expect(OutcomeTransitionDecision.$is('Apply')(decideOutcomeTransition('EFFECT_CONFIRMED', 'CONFLICT'))).toBe(true);
  });

  it('#1151 duplicate evidence of the same outcome is unchanged and counted once', () => {
    expect(decideOutcomeTransition('EFFECT_CONFIRMED', 'EFFECT_CONFIRMED')).toEqual(
      OutcomeTransitionDecision.Unchanged({ outcome: 'EFFECT_CONFIRMED' }),
    );
  });

  it('#1149 Timeout/missing callback: PENDING may become INDETERMINATE and later resolve', () => {
    expect(decideOutcomeTransition('PENDING', 'INDETERMINATE')).toEqual(
      OutcomeTransitionDecision.Apply({ from: 'PENDING', to: 'INDETERMINATE' }),
    );
    expect(decideOutcomeTransition('INDETERMINATE', 'EFFECT_CONFIRMED')).toEqual(
      OutcomeTransitionDecision.Apply({ from: 'INDETERMINATE', to: 'EFFECT_CONFIRMED' }),
    );
  });

  it('#1150 only definitive non-execution releases reservations; conflict keeps them', () => {
    expect(releasesReservations('PENDING', 'NOT_EFFECTED_CONFIRMED')).toBe(true);
    expect(releasesReservations('INDETERMINATE', 'NOT_EFFECTED_CONFIRMED')).toBe(true);
    expect(releasesReservations('PENDING', 'CONFLICT')).toBe(false);
    expect(releasesReservations('PENDING', 'EFFECT_CONFIRMED')).toBe(false);
    expect(releasesReservations('NOT_EFFECTED_CONFIRMED', 'NOT_EFFECTED_CONFIRMED')).toBe(false);
    expect((['PENDING', 'INDETERMINATE', 'CONFLICT'] as const).every((outcome) => isUnresolvedOutcome(outcome))).toBe(
      true,
    );
    expect(isUnresolvedOutcome('EFFECT_CONFIRMED')).toBe(false);
    expect(isDefinitiveOutcome('NOT_EFFECTED_CONFIRMED')).toBe(true);
    expect(isDefinitiveOutcome('CONFLICT')).toBe(false);
  });
});

describe('#1148/#1151 operation admission and collection lineage', () => {
  const request = { kind: 'COLLECT', materialHash: hashA, operationKey: 'collect-2' } as const;

  it('#1148 Retrying a collection: the same key and material replay the same operation identity', () => {
    expect(decideOperationAdmission([collect('op-1', 'INDETERMINATE')], { ...request, operationKey: 'op-1' })).toEqual(
      OperationAdmissionDecision.Replay({ operationId: 'op-1' }),
    );
  });

  it('#1151 same key with a changed material request is a conflict', () => {
    expect(
      decideOperationAdmission([collect('op-1', 'PENDING')], { ...request, materialHash: hashB, operationKey: 'op-1' }),
    ).toEqual(OperationAdmissionDecision.MaterialConflict({ operationId: 'op-1' }));
    expect(
      decideOperationAdmission([collect('op-1', 'PENDING')], {
        kind: 'REFUND',
        materialHash: hashA,
        operationKey: 'op-1',
      }),
    ).toEqual(OperationAdmissionDecision.MaterialConflict({ operationId: 'op-1' }));
  });

  it('#1151 a second COLLECT while another is PENDING, INDETERMINATE or CONFLICT returns CONFLICT', () => {
    for (const outcome of ['PENDING', 'INDETERMINATE', 'CONFLICT'] as const) {
      expect(decideOperationAdmission([collect('op-1', outcome)], request)).toEqual(
        OperationAdmissionDecision.LineageConflict({ blockingOperationId: 'op-1', blockingOutcome: outcome }),
      );
    }
  });

  it('#1151 any new COLLECT after confirmed collection returns CONFLICT (post-refund recollection denial)', () => {
    expect(decideOperationAdmission([collect('op-1', 'EFFECT_CONFIRMED')], request)).toEqual(
      OperationAdmissionDecision.LineageConflict({ blockingOperationId: 'op-1', blockingOutcome: 'EFFECT_CONFIRMED' }),
    );
  });

  it('#1151 after NOT_EFFECTED_CONFIRMED a new COLLECT is admitted (genuine non-execution recovery)', () => {
    expect(decideOperationAdmission([collect('op-1', 'NOT_EFFECTED_CONFIRMED')], request)).toEqual(
      OperationAdmissionDecision.Admit({ kind: 'COLLECT' }),
    );
  });

  it('refunds and cancellations do not open a collection lineage', () => {
    expect(
      decideOperationAdmission([collect('op-1', 'EFFECT_CONFIRMED')], {
        kind: 'REFUND',
        materialHash: hashB,
        operationKey: 'refund-1',
      }),
    ).toEqual(OperationAdmissionDecision.Admit({ kind: 'REFUND' }));
  });
});
