import { Data, Option } from 'effect';

import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type {
  PaymentCorrectionEffectKind,
  PaymentObservationFactKind,
  PaymentOperationKind,
  PaymentOperationOutcome,
} from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentSourceBinding } from '../../shared/domain/source-statement.ts';
import { sameAmount } from './money.ts';
import { decideOutcomeTransition, isDefinitiveOutcome, OutcomeTransitionDecision } from './operation-lifecycle.ts';
import { priorReturnsOf } from './refund-prior-returns.ts';
import type { PaymentReturnEvidence } from './refund-prior-returns.ts';

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
 *   already established operation is a separate effect and is held, and an effect that already
 *   established one operation never confirms another.
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

/** One previously accepted statement of the same Payment (immutable evidence). */
export interface PaymentAcceptedObservationView {
  readonly amount: PaymentMonetaryAmount | undefined;
  /** Accepted SOURCE_CORRECTION only: what it did to the Current interpretation when it was applied. */
  readonly correctionEffect?: PaymentCorrectionEffectKind | undefined;
  readonly correctsObservationId: string | undefined;
  readonly economicEffectKey: string | undefined;
  readonly factKind: PaymentObservationFactKind;
  readonly observationId: string;
  readonly operationId: string | undefined;
  /**
   * The immutable source binding that issued the statement: its economic effect keys are this source's
   * own, whichever configured authority record (method-neutral or method-specific) qualified it.
   */
  readonly source: PaymentSourceBinding;
  /** Provenance only: the configured authority record that qualified the statement. */
  readonly sourceAuthorityId: string | undefined;
}

/** The interpreter's lineage input, loaded with `listInterpretedEvidence` under the Payment row lock. */
export interface PaymentInterpretedEvidence {
  /**
   * ACCEPTED_OBSERVATION statements of the Payment. The candidate being interpreted must NOT be among
   * them: interpret first, then record the candidate with the decided acceptance outcome.
   */
  readonly acceptedObservations: readonly PaymentAcceptedObservationView[];
  /**
   * Uncorrected held or conflicting statements a governed ATTACH_EVIDENCE decision counted toward
   * `operationId`: their economic effect established that operation (#1151).
   */
  readonly attachedStatements: readonly PaymentAcceptedObservationView[];
  /**
   * Statements a qualified correction fully disproves (the persistence full-disproof rule, held
   * retractions included). Reductions of such a receipt no longer apply to its collection.
   */
  readonly fullyDisprovenObservationIds?: ReadonlySet<string>;
  /**
   * Held return statements the funds reader counts against an operation (named by their source or
   * assigned by governance). They establish no outcome; they are here only so a correction of one finds
   * its target and is recorded, which is what lets the funds reader reduce that return (#1150).
   */
  readonly priorReturnStatements?: readonly PaymentAcceptedObservationView[];
  /**
   * The Payment's prior return evidence exactly as the funds reader loads it (`selectReturnEvidence`).
   * The correction admission counts it through the same rule as the funds snapshot (#1150).
   */
  readonly returnEvidence?: readonly PaymentReturnEvidence[];
}

/** The Current aggregate the interpreter reads: `PaymentAggregateRecord` operations plus the lineage. */
export interface PaymentEvidenceAggregate extends PaymentInterpretedEvidence {
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
  /** The exact source binding the statement came from (equal to its qualifying authority's binding). */
  readonly source: PaymentSourceBinding;
  /** Provenance only: the configured authority record that qualified the statement. */
  readonly sourceAuthorityId: string;
}

export const PAYMENT_EVIDENCE_NO_CHANGE_REASONS = [
  /** The operation already has the observed outcome and nothing proves a distinct effect: counted once. */
  'CORROBORATES_ESTABLISHED_OUTCOME',
  /** Weaker (pending) evidence than the established outcome: retained as evidence only. */
  'STALE_WEAKER_EVIDENCE',
  /** Settlement/remittance is evidence about money movement, never a Payment Operation outcome. */
  'SETTLEMENT_EVIDENCE_ONLY',
  /** The corrected observation, or this correction's economic effect, was already accepted as a correction. */
  'ALREADY_CORRECTED',
] as const;
export type PaymentEvidenceNoChangeReason = (typeof PAYMENT_EVIDENCE_NO_CHANGE_REASONS)[number];

export const PAYMENT_EVIDENCE_HOLD_REASONS = [
  'UNCORRELATED_OPERATION',
  'OPERATION_NOT_IN_PAYMENT',
  'FACT_DOES_NOT_MATCH_OPERATION_KIND',
  'UNMATCHED_RETURN_EFFECT',
  'DISTINCT_ECONOMIC_EFFECT',
  /** The confirmed economic effect already established another operation: one effect counts once. */
  'ECONOMIC_EFFECT_ESTABLISHED_ANOTHER_OPERATION',
  'OPERATION_IN_CONFLICT',
  'UNRECOGNIZED_FACT',
  'CORRECTION_TARGET_UNKNOWN',
  'CORRECTION_CONTRADICTS_CORROBORATING_EVIDENCE',
  /** A statement of an already corrected economic effect is corrected again under another correction key. */
  'CORRECTION_OVERLAPS_PRIOR_CORRECTION',
  /** A partial correction would leave less proven collection than its confirmed and reserved returns. */
  'CORRECTION_EXCEEDS_REMAINING_FUNDS',
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

/** Whether persistence found the statement fully disproven (the shared rule, held retractions included). */
const isFullyDisproven = (aggregate: PaymentEvidenceAggregate, observationId: string) =>
  aggregate.fullyDisprovenObservationIds?.has(observationId) === true;

/** Accepted observations that are neither corrected nor fully disproven and are not corrections. */
const uncorrectedStatements = (aggregate: PaymentEvidenceAggregate) => {
  const corrected = new Set(
    aggregate.acceptedObservations.flatMap((observation) =>
      observation.factKind === 'SOURCE_CORRECTION' && observation.correctsObservationId !== undefined
        ? [observation.correctsObservationId]
        : [],
    ),
  );
  return aggregate.acceptedObservations.filter(
    (observation) =>
      observation.factKind !== 'SOURCE_CORRECTION' &&
      !corrected.has(observation.observationId) &&
      !isFullyDisproven(aggregate, observation.observationId),
  );
};

/**
 * Uncorrected statements that stand behind the operation's outcome: its accepted statements and the held
 * statements a governed ATTACH_EVIDENCE counted toward it.
 */
const standingObservations = (aggregate: PaymentEvidenceAggregate, operationId: string) =>
  [...uncorrectedStatements(aggregate), ...aggregate.attachedStatements].filter(
    (observation) => observation.operationId === operationId,
  );

/**
 * Statements that still identify the operation's economic effect: standing statements plus receipts that
 * only a partial correction (an amount below the operation's) reduced. A partial reduction keeps the
 * receipt's effect identity; only a full disproof removes it (#1151).
 */
const effectIdentityStatements = (aggregate: PaymentEvidenceAggregate, operation: PaymentEvidenceOperationView) => {
  const partiallyCorrectedIds = new Set<string>();
  const fullyCorrectedIds = new Set<string>();
  for (const correction of aggregate.acceptedObservations) {
    if (correction.factKind === 'SOURCE_CORRECTION' && correction.correctsObservationId !== undefined) {
      const partial = correction.amount !== undefined && correction.amount.amountMinor < operation.amount.amountMinor;
      (partial ? partiallyCorrectedIds : fullyCorrectedIds).add(correction.correctsObservationId);
    }
  }
  const partiallyCorrected = aggregate.acceptedObservations.filter(
    (statement) =>
      statement.factKind !== 'SOURCE_CORRECTION' &&
      statement.operationId === operation.operationId &&
      partiallyCorrectedIds.has(statement.observationId) &&
      !fullyCorrectedIds.has(statement.observationId) &&
      !isFullyDisproven(aggregate, statement.observationId),
  );
  return [...standingObservations(aggregate, operation.operationId), ...partiallyCorrected];
};

/** One source identity: kind, system, account and environment, independent of authority records. */
const sameSourceBinding = (left: PaymentSourceBinding, right: PaymentSourceBinding) =>
  left.sourceKind === right.sourceKind &&
  left.sourceSystem === right.sourceSystem &&
  left.accountRef === right.accountRef &&
  left.environment === right.environment;

/** One statement's economic-effect identity: its source binding and that source's own opaque key. */
export interface PaymentEffectIdentity {
  readonly economicEffectKey: string | undefined;
  readonly source: PaymentSourceBinding;
}

/**
 * Whether a confirmation is proven to restate the money its operation's standing confirmations already
 * state. Effect keys are source-scoped: a keyed statement needs a standing statement of the same source
 * binding with the same key, and a keyless one corroborates only keyless ones (#1151 "a matching amount
 * or reference alone is insufficient deduplication"). With no standing confirmation there is nothing to
 * contradict.
 */
export const restatesEstablishedEffect = (
  candidate: PaymentEffectIdentity,
  standing: readonly PaymentEffectIdentity[],
): boolean => {
  if (standing.length === 0) {
    return true;
  }
  const { economicEffectKey } = candidate;
  return economicEffectKey === undefined
    ? standing.every((prior) => prior.economicEffectKey === undefined)
    : standing.some(
        (prior) => prior.economicEffectKey === economicEffectKey && sameSourceBinding(prior.source, candidate.source),
      );
};

/**
 * The confirmed economic effect already established another operation of this Payment: an uncorrected
 * accepted or governed-attached statement of the same source binding, fact and effect key counted
 * elsewhere (#1151 "Several observations proven to describe the same economic effect count once"). The
 * method-neutral and method-specific authorities of one binding are one source: one key namespace.
 */
const establishedAnotherOperation = (
  aggregate: PaymentEvidenceAggregate,
  operation: PaymentEvidenceOperationView,
  meaning: FactMeaning,
  observation: QualifiedPaymentObservation,
) => {
  const { economicEffectKey } = observation;
  return (
    meaning.outcome === 'EFFECT_CONFIRMED' &&
    economicEffectKey !== undefined &&
    [...uncorrectedStatements(aggregate), ...aggregate.attachedStatements].some(
      (prior) =>
        prior.operationId !== undefined &&
        prior.operationId !== operation.operationId &&
        sameSourceBinding(prior.source, observation.source) &&
        prior.economicEffectKey === economicEffectKey &&
        prior.factKind === observation.factKind,
    )
  );
};

/**
 * Same established outcome: corroboration unless both sides prove different economic effects. The
 * outcome may rest on accepted statements or on held statements a governed ATTACH_EVIDENCE counted.
 */
const decideRestatement = (
  aggregate: PaymentEvidenceAggregate,
  operation: PaymentEvidenceOperationView,
  observation: QualifiedPaymentObservation,
): PaymentEvidenceDecisionCase => {
  const confirmedPriors =
    operation.outcome === 'EFFECT_CONFIRMED'
      ? effectIdentityStatements(aggregate, operation).filter(
          (prior) => paymentFactMeaning(prior.factKind)?.outcome === 'EFFECT_CONFIRMED',
        )
      : [];
  // Every confirmation that established this confirmed outcome was fully disproven (for example by a
  // held retraction): a new confirmation has nothing left to corroborate and is a separate charge.
  // Any other established outcome rests on no confirmation, so its restatement only corroborates it.
  const allConfirmationsDisproven =
    operation.outcome === 'EFFECT_CONFIRMED' &&
    confirmedPriors.length === 0 &&
    aggregate.acceptedObservations.some(
      (prior) =>
        prior.operationId === operation.operationId &&
        paymentFactMeaning(prior.factKind)?.outcome === 'EFFECT_CONFIRMED' &&
        isFullyDisproven(aggregate, prior.observationId),
    );
  return !allConfirmationsDisproven && restatesEstablishedEffect(observation, confirmedPriors)
    ? PaymentEvidenceDecision.NO_CHANGE({
        operationId: operation.operationId,
        reason: 'CORROBORATES_ESTABLISHED_OUTCOME',
      })
    : hold('DISTINCT_ECONOMIC_EFFECT', operation.operationId);
};

/**
 * A confirmed cancellation and a confirmed collection of the same COLLECT contradict each other. A step
 * that would complete the pair (automatic acceptance or governed attachment) never applies silently
 * (#1150/#1151).
 */
export const completesCancellationContradiction = (
  operations: readonly PaymentEvidenceOperationView[],
  operation: PaymentEvidenceOperationView,
  outcome: PaymentOperationOutcome,
): boolean => {
  if (outcome !== 'EFFECT_CONFIRMED') {
    return false;
  }
  if (operation.kind === 'COLLECT') {
    return operations.some(
      (other) =>
        other.kind === 'CANCEL_OR_VOID' &&
        other.targetOperationId === operation.operationId &&
        other.outcome === 'EFFECT_CONFIRMED',
    );
  }
  return (
    operation.kind === 'CANCEL_OR_VOID' &&
    operations.some(
      (other) =>
        other.kind === 'COLLECT' &&
        other.operationId === operation.targetOperationId &&
        other.outcome === 'EFFECT_CONFIRMED',
    )
  );
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
  if (establishedAnotherOperation(aggregate, operation, meaning, observation)) {
    // One economic effect counts once: it never confirms a second operation.
    return hold('ECONOMIC_EFFECT_ESTABLISHED_ANOTHER_OPERATION', operation.operationId);
  }
  if (
    isDefinitiveOutcome(meaning.outcome) &&
    observation.amount !== undefined &&
    !sameAmount(observation.amount, operation.amount)
  ) {
    // Not-effected about other money than the operation's proves nothing about this operation either.
    return conflictTo(operation, 'AMOUNT_MISMATCH');
  }
  if (operation.outcome === 'CONFLICT') {
    // Arrival order never resolves a conflict: the evidence waits for governed reconciliation.
    return hold('OPERATION_IN_CONFLICT', operation.operationId);
  }
  if (
    operation.outcome !== meaning.outcome &&
    completesCancellationContradiction(aggregate.operations, operation, meaning.outcome)
  ) {
    return conflictTo(operation, 'CONTRADICTS_DEFINITIVE_OUTCOME');
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

/** Exact amount equality where both sides may be absent (a full, amount-less statement). */
const sameOptionalAmount = (left: PaymentMonetaryAmount | undefined, right: PaymentMonetaryAmount | undefined) =>
  left === undefined || right === undefined ? left === right : sameAmount(left, right);

/**
 * True when reducing the proven collection by `reduction` (on top of the partial corrections already
 * accepted for it) would leave less than the returns confirmed or still reserved against it.
 */
const reductionExceedsRemainingFunds = (
  aggregate: PaymentEvidenceAggregate,
  operation: PaymentEvidenceOperationView,
  reduction: PaymentMonetaryAmount,
) => {
  let reduced = reduction.amountMinor;
  for (const prior of aggregate.acceptedObservations) {
    // Only corrections that were applied as a reduction count, exactly as the funds reader counts them.
    if (
      prior.correctionEffect === 'REDUCE_ESTABLISHED_COLLECTION' &&
      prior.operationId === operation.operationId &&
      prior.amount !== undefined &&
      !(prior.correctsObservationId !== undefined && isFullyDisproven(aggregate, prior.correctsObservationId))
    ) {
      reduced += prior.amount.amountMinor;
    }
  }
  // Payment REFUNDs plus the prior returns the funds reader counts, read by the one shared rule: a return
  // a counted REFUND already stands for is never added again (#1150).
  const priorReturns = priorReturnsOf(aggregate.operations, aggregate.returnEvidence ?? []).returns;
  let returns = 0;
  for (const other of [...aggregate.operations, ...priorReturns]) {
    if (
      other.kind === 'REFUND' &&
      other.targetOperationId === operation.operationId &&
      other.outcome !== 'NOT_EFFECTED_CONFIRMED'
    ) {
      returns += other.amount.amountMinor;
    }
  }
  return operation.amount.amountMinor - reduced < returns;
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
  const otherSupport = standingObservations(aggregate, operation.operationId).some((other) => {
    const support = paymentFactMeaning(other.factKind);
    // Only a statement of this operation's own kind supports its outcome: a return stated against a
    // collection is a prior return, never a second receipt.
    return (
      other.observationId !== corrected.observationId &&
      support?.kind === operation.kind &&
      support.outcome === operation.outcome
    );
  });
  if (otherSupport) {
    // Other standing evidence, accepted or governed-attached, still states the outcome: neither
    // "still proven" nor "disproven" is safe.
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
    if (reductionExceedsRemainingFunds(aggregate, operation, correction.amount)) {
      // Applying it would make the ledger inconsistent with no case to settle it: hold it as debt.
      return hold('CORRECTION_EXCEEDS_REMAINING_FUNDS', operation.operationId);
    }
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

/** The corrected statement shares its economic effect with a statement an earlier correction disproved. */
const correctsAlreadyCorrectedEffect = (
  aggregate: PaymentEvidenceAggregate,
  corrected: PaymentAcceptedObservationView,
  priorCorrections: readonly PaymentAcceptedObservationView[],
) => {
  const { economicEffectKey } = corrected;
  if (economicEffectKey === undefined) {
    return false;
  }
  const disproven = new Set(priorCorrections.flatMap((prior) => prior.correctsObservationId ?? []));
  return aggregate.acceptedObservations.some(
    (observation) =>
      disproven.has(observation.observationId) &&
      sameSourceBinding(observation.source, corrected.source) &&
      observation.economicEffectKey === economicEffectKey &&
      observation.factKind === corrected.factKind,
  );
};

/**
 * The earlier correction disproved this very statement, or another statement of the same source-scoped
 * economic effect (a re-export of it).
 */
const correctsSameReceipt = (
  aggregate: PaymentEvidenceAggregate,
  prior: PaymentAcceptedObservationView,
  corrected: PaymentAcceptedObservationView,
) => {
  if (prior.correctsObservationId === corrected.observationId) {
    return true;
  }
  const priorTarget = [...aggregate.acceptedObservations, ...aggregate.attachedStatements].find(
    (observation) => observation.observationId === prior.correctsObservationId,
  );
  return (
    priorTarget !== undefined &&
    corrected.economicEffectKey !== undefined &&
    priorTarget.economicEffectKey === corrected.economicEffectKey &&
    priorTarget.factKind === corrected.factKind &&
    sameSourceBinding(priorTarget.source, corrected.source)
  );
};

/**
 * The held prior return of a collection that the correction names. Only a return counted against a
 * COLLECT qualifies: a held statement about any other operation established nothing a correction could
 * be applied to.
 */
const correctedPriorReturnOf = (aggregate: PaymentEvidenceAggregate, correction: QualifiedPaymentObservation) =>
  (aggregate.priorReturnStatements ?? []).find(
    (statement) =>
      statement.observationId === correction.correctsObservationId &&
      aggregate.operations.some(
        (operation) => operation.operationId === statement.operationId && operation.kind === 'COLLECT',
      ),
  );

const decideCorrection = (
  aggregate: PaymentEvidenceAggregate,
  correction: QualifiedPaymentObservation,
): PaymentEvidenceDecisionCase => {
  // A statement establishes Current state the same way whether it was accepted directly or counted by a
  // governed ATTACH_EVIDENCE, so its correction is applied the same way (#1151).
  const corrected =
    [...aggregate.acceptedObservations, ...aggregate.attachedStatements].find(
      (observation) => observation.observationId === correction.correctsObservationId,
    ) ?? correctedPriorReturnOf(aggregate, correction);
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
  if (corrected.factKind === 'SOURCE_CORRECTION') {
    // Retracting an applied correction would restore funds it reduced: no automatic unwinding (#1151).
    return hold('CORRECTION_OVERLAPS_PRIOR_CORRECTION', corrected.operationId);
  }
  const priorCorrections = aggregate.acceptedObservations.filter(
    (observation) => observation.factKind === 'SOURCE_CORRECTION' && observation.operationId === corrected.operationId,
  );
  const alreadyCorrected = aggregate.acceptedObservations.some(
    (observation) =>
      observation.factKind === 'SOURCE_CORRECTION' && observation.correctsObservationId === corrected.observationId,
  );
  // The same correction effect re-issued by the same source (e.g. for a re-exported statement) counts once.
  const reissued =
    correction.economicEffectKey === undefined
      ? undefined
      : priorCorrections.find(
          (prior) =>
            sameSourceBinding(prior.source, correction.source) &&
            prior.economicEffectKey === correction.economicEffectKey &&
            sameOptionalAmount(prior.amount, correction.amount),
        );
  if (reissued !== undefined) {
    // It is a re-issue only when it corrects the same receipt or a re-export of it. The same correction
    // key against another receipt would disprove that receipt silently: hold it for reconciliation.
    return correctsSameReceipt(aggregate, reissued, corrected)
      ? PaymentEvidenceDecision.NO_CHANGE({ operationId: corrected.operationId, reason: 'ALREADY_CORRECTED' })
      : hold('CORRECTION_OVERLAPS_PRIOR_CORRECTION', corrected.operationId);
  }
  if (alreadyCorrected || correctsAlreadyCorrectedEffect(aggregate, corrected, priorCorrections)) {
    // Another correction of an already corrected statement, or of a statement of the same economic
    // effect, that is not a proven re-issue: a further or a re-issued disproof cannot be told apart,
    // so no precise remaining amount is inferred (#1151).
    return hold('CORRECTION_OVERLAPS_PRIOR_CORRECTION', corrected.operationId);
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
