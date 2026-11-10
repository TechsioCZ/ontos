import { Data } from 'effect';

import { UNRESOLVED_PAYMENT_OPERATION_OUTCOMES } from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentOperationKind, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';

/**
 * Canonical Payment Operation outcome lifecycle (#1148 "Operation outcomes", #1151 authority rules).
 * The database trigger `payment.guard_operation_update` enforces the same table as a backstop.
 *
 * - Weaker evidence (PENDING/INDETERMINATE) never overrides an established outcome: stale PENDING
 *   cannot erase EFFECT_CONFIRMED.
 * - A definitive outcome contradicted by later qualified evidence moves to CONFLICT; it is never
 *   flipped silently between EFFECT_CONFIRMED and NOT_EFFECTED_CONFIRMED.
 * - CONFLICT resolves only to a definitive outcome.
 */
export const PAYMENT_OUTCOME_TRANSITIONS: Readonly<
  Record<PaymentOperationOutcome, readonly PaymentOperationOutcome[]>
> = Object.freeze({
  CONFLICT: ['EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED'],
  EFFECT_CONFIRMED: ['CONFLICT'],
  INDETERMINATE: ['PENDING', 'EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED', 'CONFLICT'],
  NOT_EFFECTED_CONFIRMED: ['CONFLICT'],
  PENDING: ['EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED', 'INDETERMINATE', 'CONFLICT'],
});

const unresolvedOutcomes: ReadonlySet<PaymentOperationOutcome> = new Set(UNRESOLVED_PAYMENT_OPERATION_OUTCOMES);
const definitiveOutcomes: ReadonlySet<PaymentOperationOutcome> = new Set([
  'EFFECT_CONFIRMED',
  'NOT_EFFECTED_CONFIRMED',
] as const);
const weakOutcomes: ReadonlySet<PaymentOperationOutcome> = new Set(['PENDING', 'INDETERMINATE'] as const);

export const isAllowedOutcomeTransition = (from: PaymentOperationOutcome, to: PaymentOperationOutcome): boolean =>
  PAYMENT_OUTCOME_TRANSITIONS[from].includes(to);

/** PENDING, INDETERMINATE and CONFLICT keep their monetary effect and reservations unresolved (#1150). */
export const isUnresolvedOutcome = (outcome: PaymentOperationOutcome): boolean => unresolvedOutcomes.has(outcome);

/** Only definitive non-execution releases an operation's reservations (#1150). */
export const releasesReservations = (from: PaymentOperationOutcome, to: PaymentOperationOutcome): boolean =>
  from !== to && to === 'NOT_EFFECTED_CONFIRMED';

export type OutcomeTransitionDecisionCase = Data.TaggedEnum<{
  /** A legal change: append the transition row and advance the operation outcome. */
  Apply: { readonly from: PaymentOperationOutcome; readonly to: PaymentOperationOutcome };
  /** Qualified evidence contradicts a definitive outcome; the operation must move to CONFLICT. */
  Contradiction: { readonly current: PaymentOperationOutcome; readonly observed: PaymentOperationOutcome };
  /** Weaker evidence than the established outcome: retained as evidence, no state change. */
  Stale: { readonly current: PaymentOperationOutcome; readonly observed: PaymentOperationOutcome };
  /** Already the observed outcome: idempotent, counted once. */
  Unchanged: { readonly outcome: PaymentOperationOutcome };
}>;
export const OutcomeTransitionDecision = Data.taggedEnum<OutcomeTransitionDecisionCase>();

/** Interprets one qualified observed outcome against the current outcome of the same operation. */
export const decideOutcomeTransition = (
  current: PaymentOperationOutcome,
  observed: PaymentOperationOutcome,
): OutcomeTransitionDecisionCase => {
  if (current === observed) {
    return OutcomeTransitionDecision.Unchanged({ outcome: current });
  }
  if (isAllowedOutcomeTransition(current, observed)) {
    return OutcomeTransitionDecision.Apply({ from: current, to: observed });
  }
  if (weakOutcomes.has(observed)) {
    return OutcomeTransitionDecision.Stale({ current, observed });
  }
  return OutcomeTransitionDecision.Contradiction({ current, observed });
};

/** The persisted identity of one existing operation, as needed for replay and lineage decisions. */
export interface PaymentOperationIdentityView {
  readonly kind: PaymentOperationKind;
  readonly materialHash: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly outcome: PaymentOperationOutcome;
}

export type OperationAdmissionDecisionCase = Data.TaggedEnum<{
  /** No replay and no competing lineage: a new operation identity may be created. */
  Admit: { readonly kind: PaymentOperationKind };
  /** A new key cannot open a competing COLLECT lineage (#1148 aggregate invariant). */
  LineageConflict: {
    readonly blockingOperationId: string;
    readonly blockingOutcome: PaymentOperationOutcome;
  };
  /** Same operation key + changed material request. */
  MaterialConflict: { readonly operationId: string };
  /** Same operation key + same material request: the same logical operation (#1151). */
  Replay: { readonly operationId: string };
}>;
export const OperationAdmissionDecision = Data.taggedEnum<OperationAdmissionDecisionCase>();

/**
 * Decides whether a requested operation is a replay, a material conflict, a competing COLLECT
 * lineage or a new operation. Must run under the Payment row lock (`lockPayment`); the partial
 * unique index `payment_operations_one_collect_lineage_uk` is the database backstop.
 *
 * A COLLECT is admitted only when every earlier COLLECT is NOT_EFFECTED_CONFIRMED: a live
 * (PENDING/INDETERMINATE/CONFLICT) or confirmed COLLECT blocks any new collection identity.
 */
export const decideOperationAdmission = (
  existing: readonly PaymentOperationIdentityView[],
  request: { readonly kind: PaymentOperationKind; readonly materialHash: string; readonly operationKey: string },
): OperationAdmissionDecisionCase => {
  const sameKey = existing.find((operation) => operation.operationKey === request.operationKey);
  if (sameKey !== undefined) {
    return sameKey.kind === request.kind && sameKey.materialHash === request.materialHash
      ? OperationAdmissionDecision.Replay({ operationId: sameKey.operationId })
      : OperationAdmissionDecision.MaterialConflict({ operationId: sameKey.operationId });
  }
  if (request.kind === 'COLLECT') {
    const blocking = existing.find(
      (operation) => operation.kind === 'COLLECT' && operation.outcome !== 'NOT_EFFECTED_CONFIRMED',
    );
    if (blocking !== undefined) {
      return OperationAdmissionDecision.LineageConflict({
        blockingOperationId: blocking.operationId,
        blockingOutcome: blocking.outcome,
      });
    }
  }
  return OperationAdmissionDecision.Admit({ kind: request.kind });
};

/** True when the outcome is definitive (EFFECT_CONFIRMED or NOT_EFFECTED_CONFIRMED). */
export const isDefinitiveOutcome = (outcome: PaymentOperationOutcome): boolean => definitiveOutcomes.has(outcome);
