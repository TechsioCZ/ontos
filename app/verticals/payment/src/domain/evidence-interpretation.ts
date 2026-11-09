import { Data, Option } from 'effect';

import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type {
  PaymentObservationFactKind,
  PaymentOperationKind,
  PaymentOperationOutcome,
} from '../../shared/domain/payment-vocabulary.ts';
import { sameAmount } from './money.ts';
import { decideOutcomeTransition, OutcomeTransitionDecision } from './operation-lifecycle.ts';

/**
 * Pure interpretation of one qualified Payment Observation against the Current Payment aggregate
 * (#1151 "Authority and conflict rules"). The caller (accept/record evidence Actions) has already
 * qualified source authority, scope, binding and correlation (#1152) and applies the decision with
 * the aggregate persistence primitives under the Payment row lock.
 *
 * - Arrival order never establishes truth: a definitive outcome contradicted by later evidence and an
 *   operation already in CONFLICT are resolved only by governed reconciliation, never by "latest wins".
 * - Stale PENDING evidence cannot erase an established outcome.
 * - A real later refund is a separate monetary effect of its own REFUND operation; it never becomes
 *   "stale" and never rewrites the original collection. A return that no Payment operation explains
 *   is held, not dropped.
 * - A source correction disproves an earlier statement: the operation that statement established
 *   returns to CONFLICT (or its proven collection is reduced) and coverage drops. No refund is invented.
 * - Corroborating observations of the same economic effect count once; a distinct effect key on an
 *   already established operation is a separate effect and is held.
 * - Anything ambiguous or unassignable becomes HOLD (reconciliation debt), never a first-match guess.
 */

/** One persisted operation as the interpreter needs it (structurally satisfied by `PaymentOperationRecord`). */
export interface PaymentEvidenceOperationView {
  readonly amount: PaymentMonetaryAmount;
  readonly kind: PaymentOperationKind;
  readonly operationId: string;
  readonly outcome: PaymentOperationOutcome;
  readonly outcomeRevision: number;
  readonly targetOperationId: string | undefined;
}

/** One previously ACCEPTED_OBSERVATION of the same Payment (immutable evidence). */
export interface PaymentAcceptedObservationView {
  readonly amount: PaymentMonetaryAmount | undefined;
  readonly correctsObservationId: string | undefined;
  readonly economicEffectKey: string | undefined;
  readonly factKind: PaymentObservationFactKind;
  readonly observationId: string;
  readonly operationId: string | undefined;
}

/**
 * The Current aggregate the interpreter reads. `PaymentAggregateRecord` from `loadAggregate` plus the
 * accepted observations from `paymentEvidencePersistenceForTransaction(...).listAcceptedObservations`.
 * The candidate being interpreted must NOT be among `acceptedObservations`: interpret first, then
 * record the candidate with the decided acceptance outcome.
 */
export interface PaymentEvidenceAggregate {
  readonly acceptedObservations: readonly PaymentAcceptedObservationView[];
  readonly operations: readonly PaymentEvidenceOperationView[];
}

/** The newly qualified observation (exact correlation established by source qualification). */
export interface QualifiedPaymentObservation {
  readonly amount: PaymentMonetaryAmount | undefined;
  /** Set only for SOURCE_CORRECTION: the accepted observation whose statement is disproven. */
  readonly correctsObservationId: string | undefined;
  readonly economicEffectKey: string | undefined;
  readonly factKind: PaymentObservationFactKind;
  /** Exact Payment Operation correlation; absent when the source could not prove it. */
  readonly operationId: string | undefined;
}

export const PAYMENT_EVIDENCE_NO_CHANGE_REASONS = [
  /** The operation already has the observed outcome and nothing proves a distinct effect: counted once. */
  'CORROBORATES_ESTABLISHED_OUTCOME',
  /** Weaker (pending) evidence than the established outcome: retained as evidence only. */
  'STALE_WEAKER_EVIDENCE',
  /** Settlement/remittance is evidence about money movement, never a Payment Operation outcome. */
  'SETTLEMENT_EVIDENCE_ONLY',
  /** The corrected observation was already corrected by another accepted correction. */
  'ALREADY_CORRECTED',
] as const;
export type PaymentEvidenceNoChangeReason = (typeof PAYMENT_EVIDENCE_NO_CHANGE_REASONS)[number];

export const PAYMENT_EVIDENCE_HOLD_REASONS = [
  'UNCORRELATED_OPERATION',
  'OPERATION_NOT_IN_PAYMENT',
  'FACT_DOES_NOT_MATCH_OPERATION_KIND',
  'UNMATCHED_RETURN_EFFECT',
  'DISTINCT_ECONOMIC_EFFECT',
  'OPERATION_IN_CONFLICT',
  'UNRECOGNIZED_FACT',
  'CORRECTION_TARGET_UNKNOWN',
  'CORRECTION_CONTRADICTS_CORROBORATING_EVIDENCE',
] as const;
export type PaymentEvidenceHoldReason = (typeof PAYMENT_EVIDENCE_HOLD_REASONS)[number];

export const PAYMENT_EVIDENCE_CONFLICT_REASONS = [
  /** Qualified evidence contradicts the definitive outcome of the same operation. */
  'CONTRADICTS_DEFINITIVE_OUTCOME',
  /** The observed amount differs from the operation's exact immutable amount. */
  'AMOUNT_MISMATCH',
  /** The correction names a different operation than the statement it corrects. */
  'CORRECTION_LINEAGE_MISMATCH',
] as const;
export type PaymentEvidenceConflictReason = (typeof PAYMENT_EVIDENCE_CONFLICT_REASONS)[number];

/** The optimistic fence the caller passes to `transitionOperationOutcome`. */
export interface PaymentEvidenceOutcomeChange {
  readonly expectedOutcomeRevision: number;
  readonly from: PaymentOperationOutcome;
  readonly operationId: string;
  readonly to: PaymentOperationOutcome;
}

export type PaymentCorrectionEffectCase = Data.TaggedEnum<{
  /** The disproven statement never established the Current outcome: lineage only. */
  RECORD_ONLY: object;
  /** A partial disproof of proven collection: the correction amount reduces Current coverage. */
  REDUCE_ESTABLISHED_COLLECTION: { readonly amount: PaymentMonetaryAmount };
  /** The disproven statement established the Current outcome: the operation returns to CONFLICT. */
  REOPEN_TO_CONFLICT: { readonly change: PaymentEvidenceOutcomeChange };
}>;
export const PaymentCorrectionEffect = Data.taggedEnum<PaymentCorrectionEffectCase>();

export type PaymentEvidenceDecisionCase = Data.TaggedEnum<{
  /** Apply with the CONFLICT transition (if any) and open an OPERATION_CONFLICT reconciliation case. */
  CONFLICT: {
    /** Some: move the operation to CONFLICT with this fence; None: it is already CONFLICT or unaffected. */
    readonly change: Option.Option<PaymentEvidenceOutcomeChange>;
    readonly operationId: string | undefined;
    readonly reason: PaymentEvidenceConflictReason;
  };
  /** Attach the correction lineage; apply `effect`; the original observation stays immutable. */
  CORRECTION: {
    readonly affectedOperationId: string;
    readonly correctedObservationId: string;
    readonly effect: PaymentCorrectionEffectCase;
  };
  /** Keep the evidence as held reconciliation debt; no outcome change. */
  HOLD: { readonly operationId: string | undefined; readonly reason: PaymentEvidenceHoldReason };
  /** Evidence retained; the Current interpretation is unchanged. */
  NO_CHANGE: { readonly operationId: string | undefined; readonly reason: PaymentEvidenceNoChangeReason };
  /** A legal outcome change of the correlated operation. */
  TRANSITION: PaymentEvidenceOutcomeChange;
}>;
export const PaymentEvidenceDecision = Data.taggedEnum<PaymentEvidenceDecisionCase>();

interface FactMeaning {
  readonly kind: PaymentOperationKind;
  readonly outcome: PaymentOperationOutcome;
}

/** Outcome facts only; settlement, correction and unrecognized facts carry no operation outcome. */
const FACT_MEANINGS: Readonly<Partial<Record<PaymentObservationFactKind, FactMeaning>>> = Object.freeze({
  CANCEL_CONFIRMED: { kind: 'CANCEL_OR_VOID', outcome: 'EFFECT_CONFIRMED' },
  CANCEL_NOT_EFFECTED: { kind: 'CANCEL_OR_VOID', outcome: 'NOT_EFFECTED_CONFIRMED' },
  COLLECTION_CONFIRMED: { kind: 'COLLECT', outcome: 'EFFECT_CONFIRMED' },
  COLLECTION_NOT_EFFECTED: { kind: 'COLLECT', outcome: 'NOT_EFFECTED_CONFIRMED' },
  COLLECTION_PENDING: { kind: 'COLLECT', outcome: 'PENDING' },
  REFUND_CONFIRMED: { kind: 'REFUND', outcome: 'EFFECT_CONFIRMED' },
  REFUND_NOT_EFFECTED: { kind: 'REFUND', outcome: 'NOT_EFFECTED_CONFIRMED' },
  REFUND_PENDING: { kind: 'REFUND', outcome: 'PENDING' },
});

/** The canonical business meaning of an outcome fact; `undefined` for settlement/correction/unrecognized. */
export const paymentFactMeaning = (factKind: PaymentObservationFactKind): FactMeaning | undefined =>
  FACT_MEANINGS[factKind];

const hold = (reason: PaymentEvidenceHoldReason, operationId?: string) =>
  PaymentEvidenceDecision.HOLD({ operationId, reason });

const conflictTo = (
  operation: PaymentEvidenceOperationView,
  reason: PaymentEvidenceConflictReason,
): PaymentEvidenceDecisionCase =>
  PaymentEvidenceDecision.CONFLICT({
    change:
      operation.outcome === 'CONFLICT'
        ? Option.none()
        : Option.some({
            expectedOutcomeRevision: operation.outcomeRevision,
            from: operation.outcome,
            operationId: operation.operationId,
            to: 'CONFLICT',
          }),
    operationId: operation.operationId,
    reason,
  });

const isReturnFact = (meaning: FactMeaning) => meaning.kind === 'REFUND';

/** Accepted observations of the operation that are not themselves corrected and are not corrections. */
const standingObservations = (aggregate: PaymentEvidenceAggregate, operationId: string) => {
  const corrected = new Set(
    aggregate.acceptedObservations.flatMap((observation) =>
      observation.factKind === 'SOURCE_CORRECTION' && observation.correctsObservationId !== undefined
        ? [observation.correctsObservationId]
        : [],
    ),
  );
  return aggregate.acceptedObservations.filter(
    (observation) =>
      observation.operationId === operationId &&
      observation.factKind !== 'SOURCE_CORRECTION' &&
      !corrected.has(observation.observationId),
  );
};

/** Same established outcome: corroboration unless both sides prove different economic effects. */
const decideRestatement = (
  aggregate: PaymentEvidenceAggregate,
  operation: PaymentEvidenceOperationView,
  observation: QualifiedPaymentObservation,
): PaymentEvidenceDecisionCase => {
  const { economicEffectKey } = observation;
  const distinct =
    economicEffectKey !== undefined &&
    operation.outcome === 'EFFECT_CONFIRMED' &&
    standingObservations(aggregate, operation.operationId).some(
      (prior) =>
        prior.economicEffectKey !== undefined &&
        prior.economicEffectKey !== economicEffectKey &&
        paymentFactMeaning(prior.factKind)?.outcome === 'EFFECT_CONFIRMED',
    );
  return distinct
    ? hold('DISTINCT_ECONOMIC_EFFECT', operation.operationId)
    : PaymentEvidenceDecision.NO_CHANGE({
        operationId: operation.operationId,
        reason: 'CORROBORATES_ESTABLISHED_OUTCOME',
      });
};

const decideOutcomeFact = (
  aggregate: PaymentEvidenceAggregate,
  operation: PaymentEvidenceOperationView,
  meaning: FactMeaning,
  observation: QualifiedPaymentObservation,
): PaymentEvidenceDecisionCase => {
  if (operation.kind !== meaning.kind) {
    // A return reported against the collection is a separate effect no Payment operation explains.
    return isReturnFact(meaning) && operation.kind === 'COLLECT'
      ? hold('UNMATCHED_RETURN_EFFECT', operation.operationId)
      : hold('FACT_DOES_NOT_MATCH_OPERATION_KIND', operation.operationId);
  }
  if (
    meaning.outcome === 'EFFECT_CONFIRMED' &&
    observation.amount !== undefined &&
    !sameAmount(observation.amount, operation.amount)
  ) {
    return conflictTo(operation, 'AMOUNT_MISMATCH');
  }
  if (operation.outcome === 'CONFLICT') {
    // Arrival order never resolves a conflict: the evidence waits for governed reconciliation.
    return hold('OPERATION_IN_CONFLICT', operation.operationId);
  }
  return OutcomeTransitionDecision.$match(decideOutcomeTransition(operation.outcome, meaning.outcome), {
    Apply: ({ from, to }) =>
      PaymentEvidenceDecision.TRANSITION({
        expectedOutcomeRevision: operation.outcomeRevision,
        from,
        operationId: operation.operationId,
        to,
      }),
    Contradiction: () => conflictTo(operation, 'CONTRADICTS_DEFINITIVE_OUTCOME'),
    Stale: () =>
      PaymentEvidenceDecision.NO_CHANGE({ operationId: operation.operationId, reason: 'STALE_WEAKER_EVIDENCE' }),
    Unchanged: () => decideRestatement(aggregate, operation, observation),
  });
};

const correctionEffectFor = (
  aggregate: PaymentEvidenceAggregate,
  operation: PaymentEvidenceOperationView,
  corrected: PaymentAcceptedObservationView,
  correction: QualifiedPaymentObservation,
): PaymentEvidenceDecisionCase => {
  const meaning = paymentFactMeaning(corrected.factKind);
  const established =
    meaning !== undefined &&
    meaning.kind === operation.kind &&
    meaning.outcome === operation.outcome &&
    meaning.outcome !== 'PENDING';
  const lineage = { affectedOperationId: operation.operationId, correctedObservationId: corrected.observationId };
  if (!established) {
    return PaymentEvidenceDecision.CORRECTION({ ...lineage, effect: PaymentCorrectionEffect.RECORD_ONLY() });
  }
  const otherSupport = standingObservations(aggregate, operation.operationId).some(
    (other) =>
      other.observationId !== corrected.observationId &&
      paymentFactMeaning(other.factKind)?.outcome === operation.outcome,
  );
  if (otherSupport) {
    // Other standing evidence still states the outcome: neither "still proven" nor "disproven" is safe.
    return hold('CORRECTION_CONTRADICTS_CORROBORATING_EVIDENCE', operation.operationId);
  }
  const partial =
    operation.kind === 'COLLECT' &&
    operation.outcome === 'EFFECT_CONFIRMED' &&
    correction.amount !== undefined &&
    correction.amount.currency === operation.amount.currency &&
    correction.amount.amountMinor > 0 &&
    correction.amount.amountMinor < operation.amount.amountMinor;
  if (partial && correction.amount !== undefined) {
    return PaymentEvidenceDecision.CORRECTION({
      ...lineage,
      effect: PaymentCorrectionEffect.REDUCE_ESTABLISHED_COLLECTION({ amount: correction.amount }),
    });
  }
  return PaymentEvidenceDecision.CORRECTION({
    ...lineage,
    effect: PaymentCorrectionEffect.REOPEN_TO_CONFLICT({
      change: {
        expectedOutcomeRevision: operation.outcomeRevision,
        from: operation.outcome,
        operationId: operation.operationId,
        to: 'CONFLICT',
      },
    }),
  });
};

const decideCorrection = (
  aggregate: PaymentEvidenceAggregate,
  correction: QualifiedPaymentObservation,
): PaymentEvidenceDecisionCase => {
  const corrected = aggregate.acceptedObservations.find(
    (observation) => observation.observationId === correction.correctsObservationId,
  );
  if (corrected === undefined || corrected.operationId === undefined) {
    return hold('CORRECTION_TARGET_UNKNOWN', correction.operationId);
  }
  if (correction.operationId !== undefined && correction.operationId !== corrected.operationId) {
    return PaymentEvidenceDecision.CONFLICT({
      change: Option.none(),
      operationId: corrected.operationId,
      reason: 'CORRECTION_LINEAGE_MISMATCH',
    });
  }
  const alreadyCorrected = aggregate.acceptedObservations.some(
    (observation) =>
      observation.factKind === 'SOURCE_CORRECTION' && observation.correctsObservationId === corrected.observationId,
  );
  if (alreadyCorrected) {
    return PaymentEvidenceDecision.NO_CHANGE({ operationId: corrected.operationId, reason: 'ALREADY_CORRECTED' });
  }
  const operation = aggregate.operations.find((candidate) => candidate.operationId === corrected.operationId);
  if (operation === undefined) {
    return hold('OPERATION_NOT_IN_PAYMENT', corrected.operationId);
  }
  return correctionEffectFor(aggregate, operation, corrected, correction);
};

/**
 * Interprets one qualified observation against the Current aggregate. Pure: the same inputs always
 * give the same decision, independent of arrival order or wall-clock time.
 */
export const interpretPaymentObservation = (
  aggregate: PaymentEvidenceAggregate,
  observation: QualifiedPaymentObservation,
): PaymentEvidenceDecisionCase => {
  if (observation.factKind === 'SOURCE_CORRECTION') {
    return decideCorrection(aggregate, observation);
  }
  if (observation.factKind === 'UNRECOGNIZED') {
    return hold('UNRECOGNIZED_FACT', observation.operationId);
  }
  if (observation.operationId === undefined) {
    return hold('UNCORRELATED_OPERATION');
  }
  const { operationId } = observation;
  const operation = aggregate.operations.find((candidate) => candidate.operationId === operationId);
  if (operation === undefined) {
    return hold('OPERATION_NOT_IN_PAYMENT', operationId);
  }
  const meaning = paymentFactMeaning(observation.factKind);
  if (meaning === undefined) {
    return PaymentEvidenceDecision.NO_CHANGE({ operationId, reason: 'SETTLEMENT_EVIDENCE_ONLY' });
  }
  return decideOutcomeFact(aggregate, operation, meaning, observation);
};
