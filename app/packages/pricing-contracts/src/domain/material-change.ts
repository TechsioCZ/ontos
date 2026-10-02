import { Schema } from 'effect';

import { PricingInstantSchema } from './currency-support.ts';
import { PricingMaterialCalculationVersionsSchema } from './material-evidence.ts';
import { PricingDecisionSchema } from './pricing-decision.ts';
import {
  PricingSourceEvidenceFamilySchema,
  PricingSourceEvidenceConflictSchema,
  PricingSourceEvidenceOwnerScopeSchema,
  PricingSourceEvidenceReferenceSchema,
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from './source-revision-evidence.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

export const PricingEvaluationRunIdSchema = stableReference.pipe(
  Schema.brand('PricingEvaluationRunId'),
  Schema.decodeTo(Schema.String),
);
export type PricingEvaluationRunId = typeof PricingEvaluationRunIdSchema.Type;

export const PricingEvaluationAttemptIdSchema = stableReference.pipe(
  Schema.brand('PricingEvaluationAttemptId'),
  Schema.decodeTo(Schema.String),
);
export type PricingEvaluationAttemptId = typeof PricingEvaluationAttemptIdSchema.Type;

export const PricingMaterialSnapshotIdSchema = stableReference.pipe(
  Schema.brand('PricingMaterialSnapshotId'),
  Schema.decodeTo(Schema.String),
);
export type PricingMaterialSnapshotId = typeof PricingMaterialSnapshotIdSchema.Type;

export const PricingMaterialBindingKindSchema = Schema.Literals([
  'PURCHASE_OCCURRENCES',
  'CATALOG_SELECTION',
  'QUANTITY_AND_UNIT',
  'PACKAGE_CONFIGURATION_OR_SET',
  'COMMERCIAL_SCOPE',
  'SUBJECT_OR_GUEST',
  'AUDIENCE_OR_GROUP',
  'CURRENCY_SUPPORT',
  'EXACT_PRICE_SET',
  'PRICE_SCHEDULE',
  'QUANTITY_TIER_SET',
  'DISCOUNT_SET',
  'COMMERCIAL_FEE_SET',
  'PROMOTION_OR_ALLOCATION',
  'ZERO_FLOOR_SCOPE_OR_COVERAGE',
  'WHOLE_PURCHASE_BASIS_OR_ALLOCATION',
  'CALCULATION_CONTRACT',
  'ROUNDING_CONTRACT',
]);
export type PricingMaterialBindingKind = typeof PricingMaterialBindingKindSchema.Type;

/**
 * One exact material meaning bound to its owner-issued #786 result. `meaningRef` is only an
 * identity inside this snapshot; consumers must not use equality of that reference as proof that
 * two snapshots have equivalent business meaning.
 */
export const PricingMaterialBindingSchema = Schema.Struct({
  bindingRef: stableReference,
  kind: PricingMaterialBindingKindSchema,
  meaningRef: stableReference,
  sourceEvidence: PricingSourceEvidenceResultSchema,
});
export type PricingMaterialBinding = typeof PricingMaterialBindingSchema.Type;

export const PricingNonMaterialObservationSchema = Schema.Struct({
  kind: Schema.Literals(['STOREFRONT_ORIGIN', 'TAX_ONLY']),
  observationRef: stableReference,
});
export type PricingNonMaterialObservation = typeof PricingNonMaterialObservationSchema.Type;

const sourceObservedAt = (source: typeof PricingSourceEvidenceResultSchema.Type): string =>
  Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source) ||
  Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(source) ||
  Schema.is(PricingSourceEvidenceConflictSchema)(source)
    ? source.completeness.temporal.observedAt
    : source.observedAt;

/** A single coherent attempt snapshot. It retains the full owner proof, never a revision-only vector. */
export const PricingMaterialStateSnapshotSchema = Schema.Struct({
  attemptId: PricingEvaluationAttemptIdSchema,
  calculationVersions: PricingMaterialCalculationVersionsSchema,
  candidateRef: stableReference,
  capturedAt: PricingInstantSchema,
  decision: PricingDecisionSchema,
  materialBindings: Schema.Array(PricingMaterialBindingSchema).check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  nonMaterialObservations: Schema.optionalKey(
    Schema.Array(PricingNonMaterialObservationSchema).check(Schema.isMaxLength(100)),
  ),
  requestedAt: PricingInstantSchema,
  snapshotId: PricingMaterialSnapshotIdSchema,
}).check(
  Schema.makeFilter(({ capturedAt, decision, materialBindings, requestedAt }) => {
    if (requestedAt > capturedAt) {
      return 'A material snapshot cannot be captured before its owner reads were requested';
    }
    const bindingRefs = materialBindings.map(({ bindingRef }) => bindingRef);
    if (new Set(bindingRefs).size !== bindingRefs.length) {
      return 'A material snapshot must contain unique binding references';
    }
    return materialBindings.every(({ sourceEvidence }) => {
      const { request } = sourceEvidence;
      return (
        request.ownerScope.tenantId === decision.tenantId &&
        request.effectiveAt === decision.operationTime &&
        request.requestedAt === requestedAt &&
        (request.currencyCode === undefined || request.currencyCode === decision.currencyCode) &&
        sourceObservedAt(sourceEvidence) <= capturedAt
      );
    })
      ? undefined
      : 'Every material binding must preserve the exact candidate time, Tenant, currency, request, and actual owner timing';
  }),
);
export type PricingMaterialStateSnapshot = typeof PricingMaterialStateSnapshotSchema.Type;

/**
 * One whole evaluation attempt owns exactly one snapshot. The second attempt is always fresh;
 * neither the schema nor the retry outcomes contain a field that can merge bindings across them.
 */
export const PricingEvaluationAttemptSchema = Schema.Struct({
  attemptId: PricingEvaluationAttemptIdSchema,
  attemptOrdinal: Schema.Literals([1, 2]),
  candidateRef: stableReference,
  completedAt: PricingInstantSchema,
  maxAttempts: Schema.Literal(2),
  runId: PricingEvaluationRunIdSchema,
  snapshot: PricingMaterialStateSnapshotSchema,
  startedAt: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ attemptId, candidateRef, completedAt, snapshot, startedAt }) => {
    if (attemptId !== snapshot.attemptId || candidateRef !== snapshot.candidateRef) {
      return 'An evaluation attempt must own one coherent snapshot for the exact candidate';
    }
    return startedAt <= snapshot.requestedAt && snapshot.capturedAt <= completedAt
      ? undefined
      : 'An evaluation attempt must preserve actual request, capture, and completion ordering';
  }),
);
export type PricingEvaluationAttempt = typeof PricingEvaluationAttemptSchema.Type;

const verifiedSourceEvidenceSchema = Schema.Union([
  PricingSourceEvidenceVerifiedPresentSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
]);
const sameOwnerScope = Schema.toEquivalence(PricingSourceEvidenceOwnerScopeSchema);
const sameSourceEvidence = Schema.toEquivalence(PricingSourceEvidenceResultSchema);

/**
 * Only an owner may attest that changed proof carries unchanged business meaning. Full before and
 * after #786 proofs and their actual timing are retained; matching JSON, amount, labels, or
 * Revision strings is intentionally not a substitute.
 */
export const PricingMaterialOwnerTransitionEvidenceSchema = Schema.Struct({
  bindingRef: stableReference,
  confirmedAt: PricingInstantSchema,
  currentEvidence: verifiedSourceEvidenceSchema,
  currentSnapshotId: PricingMaterialSnapshotIdSchema,
  family: PricingSourceEvidenceFamilySchema,
  ownerScope: PricingSourceEvidenceOwnerScopeSchema,
  previousEvidence: verifiedSourceEvidenceSchema,
  previousSnapshotId: PricingMaterialSnapshotIdSchema,
  transitionRef: PricingSourceEvidenceReferenceSchema,
  verification: Schema.Struct({
    kind: Schema.Literal('OWNER_CONFIRMED_NON_MATERIAL_TRANSITION'),
    verificationRef: PricingSourceEvidenceReferenceSchema,
  }),
}).check(
  Schema.makeFilter((transition) => {
    const previousRequest = transition.previousEvidence.request;
    const currentRequest = transition.currentEvidence.request;
    if (
      transition.previousSnapshotId === transition.currentSnapshotId ||
      previousRequest.family !== transition.family ||
      currentRequest.family !== transition.family ||
      !sameOwnerScope(previousRequest.ownerScope, transition.ownerScope) ||
      !sameOwnerScope(currentRequest.ownerScope, transition.ownerScope)
    ) {
      return 'A non-material transition must bind distinct snapshots and both exact owner proof scopes';
    }
    return sourceObservedAt(transition.previousEvidence) <= transition.confirmedAt &&
      sourceObservedAt(transition.currentEvidence) <= transition.confirmedAt
      ? undefined
      : 'A non-material transition confirmation cannot predate either actual owner observation';
  }),
);
export type PricingMaterialOwnerTransitionEvidence = typeof PricingMaterialOwnerTransitionEvidenceSchema.Type;

export const PricingMaterialChangeReasonSchema = Schema.Literals([
  'PURCHASE_OCCURRENCES_CHANGED',
  'CATALOG_SELECTION_CHANGED',
  'QUANTITY_OR_UNIT_CHANGED',
  'PACKAGE_CONFIGURATION_OR_SET_CHANGED',
  'COMMERCIAL_SCOPE_CHANGED',
  'SUBJECT_OR_GUEST_CHANGED',
  'AUDIENCE_OR_GROUP_CHANGED',
  'CURRENCY_OR_BASIS_CHANGED',
  'CURRENCY_SUPPORT_CHANGED',
  'EXACT_PRICE_KEY_OR_SET_CHANGED',
  'PRICE_SCHEDULE_BOUNDARY_CROSSED',
  'QUANTITY_TIER_SET_CHANGED',
  'DISCOUNT_SET_CHANGED',
  'COMMERCIAL_FEE_SET_CHANGED',
  'PROMOTION_OR_ALLOCATION_CHANGED',
  'ZERO_FLOOR_SCOPE_OR_COVERAGE_CHANGED',
  'WHOLE_PURCHASE_BASIS_OR_ALLOCATION_CHANGED',
  'CALCULATION_CONTRACT_CHANGED',
  'ROUNDING_CONTRACT_CHANGED',
  'OWNER_PROVEN_OTHER_MATERIAL_CHANGE',
]);
export type PricingMaterialChangeReason = typeof PricingMaterialChangeReasonSchema.Type;

export const PricingMaterialChangeAssessmentRequestSchema = Schema.Struct({
  current: PricingMaterialStateSnapshotSchema,
  ownerTransitions: Schema.Array(PricingMaterialOwnerTransitionEvidenceSchema).check(Schema.isMaxLength(2000)),
  previous: PricingMaterialStateSnapshotSchema,
}).check(
  Schema.makeFilter(({ current, ownerTransitions, previous }) =>
    ownerTransitions.every((transition) => {
      const previousBinding = previous.materialBindings.find(({ bindingRef }) => bindingRef === transition.bindingRef);
      const currentBinding = current.materialBindings.find(({ bindingRef }) => bindingRef === transition.bindingRef);
      return (
        transition.previousSnapshotId === previous.snapshotId &&
        transition.currentSnapshotId === current.snapshotId &&
        previousBinding !== undefined &&
        currentBinding !== undefined &&
        sameSourceEvidence(previousBinding.sourceEvidence, transition.previousEvidence) &&
        sameSourceEvidence(currentBinding.sourceEvidence, transition.currentEvidence)
      );
    })
      ? undefined
      : 'Every owner transition must bind one exact before/after material binding and its full proof',
  ),
);
export type PricingMaterialChangeAssessmentRequest = typeof PricingMaterialChangeAssessmentRequestSchema.Type;

export const PricingMaterialChangedSchema = Schema.TaggedStruct('MATERIAL_CHANGED', {
  currentSnapshotId: PricingMaterialSnapshotIdSchema,
  previousSnapshotId: PricingMaterialSnapshotIdSchema,
  reasons: Schema.Array(PricingMaterialChangeReasonSchema).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ currentSnapshotId, previousSnapshotId }) =>
    currentSnapshotId === previousSnapshotId ? 'Material change requires distinct snapshot identities' : undefined,
  ),
);
export const PricingOwnerConfirmedNonMaterialSchema = Schema.TaggedStruct('OWNER_CONFIRMED_NON_MATERIAL', {
  currentSnapshotId: PricingMaterialSnapshotIdSchema,
  previousSnapshotId: PricingMaterialSnapshotIdSchema,
  transitions: Schema.Array(PricingMaterialOwnerTransitionEvidenceSchema).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ currentSnapshotId, previousSnapshotId, transitions }) =>
    currentSnapshotId !== previousSnapshotId &&
    transitions.every(
      (transition) =>
        transition.currentSnapshotId === currentSnapshotId && transition.previousSnapshotId === previousSnapshotId,
    )
      ? undefined
      : 'Owner-confirmed non-material classification must bind every transition to the compared snapshots',
  ),
);
export const PricingNonMaterialSchema = Schema.TaggedStruct('NON_MATERIAL', {
  currentSnapshotId: PricingMaterialSnapshotIdSchema,
  previousSnapshotId: PricingMaterialSnapshotIdSchema,
  reason: Schema.Literals(['EXACT_MATERIAL_STATE', 'STOREFRONT_OR_TAX_ONLY']),
}).check(
  Schema.makeFilter(({ currentSnapshotId, previousSnapshotId }) =>
    currentSnapshotId === previousSnapshotId ? 'Non-material revalidation requires a fresh snapshot' : undefined,
  ),
);
export const PricingMaterialChangeUnverifiableSchema = Schema.TaggedStruct('UNVERIFIABLE', {
  currentSnapshotId: PricingMaterialSnapshotIdSchema,
  previousSnapshotId: PricingMaterialSnapshotIdSchema,
  reasons: Schema.Array(boundedReason).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ currentSnapshotId, previousSnapshotId }) =>
    currentSnapshotId === previousSnapshotId ? 'Unverifiable comparison requires distinct snapshots' : undefined,
  ),
);
export const PricingMaterialChangeClassificationSchema = Schema.Union([
  PricingMaterialChangedSchema,
  PricingNonMaterialSchema,
  PricingOwnerConfirmedNonMaterialSchema,
  PricingMaterialChangeUnverifiableSchema,
]);
export type PricingMaterialChangeClassification = typeof PricingMaterialChangeClassificationSchema.Type;

export const PricingFreshAttemptOutcomeSchema = Schema.TaggedStruct('FRESH', {
  attempt: PricingEvaluationAttemptSchema,
  retryDirective: Schema.Literal('NONE'),
});
export const PricingKnownStaleOrMaterialChangedOutcomeSchema = Schema.TaggedStruct('KNOWN_STALE_OR_MATERIAL_CHANGED', {
  attempt: PricingEvaluationAttemptSchema,
  classification: PricingMaterialChangedSchema,
  retryDirective: Schema.Literal('RETRY_WHOLE_ATTEMPT'),
}).check(
  Schema.makeFilter(({ attempt, classification }) => {
    if (classification.currentSnapshotId !== attempt.snapshot.snapshotId) {
      return 'A stale outcome must bind the changed current snapshot to its exact attempt';
    }
    return attempt.attemptOrdinal === 1 ? undefined : 'Only the first whole attempt may request a fresh retry';
  }),
);
export const PricingKnownInvalidOrConflictOutcomeSchema = Schema.TaggedStruct('KNOWN_INVALID_OR_CONFLICT', {
  attempt: PricingEvaluationAttemptSchema,
  reason: boundedReason,
  retryDirective: Schema.Literal('NONE'),
});
export const PricingIndeterminateOrUnverifiableOutcomeSchema = Schema.TaggedStruct('INDETERMINATE_OR_UNVERIFIABLE', {
  attempt: PricingEvaluationAttemptSchema,
  reason: boundedReason,
  retryDirective: Schema.Literal('RETRY_WHOLE_ATTEMPT'),
}).check(
  Schema.makeFilter(({ attempt }) =>
    attempt.attemptOrdinal === 1 ? undefined : 'Only the first whole attempt may request a fresh retry',
  ),
);

const PricingRetryableFailureKindSchema = Schema.Literals([
  'KNOWN_STALE_OR_MATERIAL_CHANGED',
  'INDETERMINATE_OR_UNVERIFIABLE',
]);

export const PricingRetryExhaustedOutcomeSchema = Schema.TaggedStruct('RETRY_EXHAUSTED', {
  finalAttempt: PricingEvaluationAttemptSchema,
  finalFailure: PricingRetryableFailureKindSchema,
  firstAttempt: PricingEvaluationAttemptSchema,
  firstFailure: PricingRetryableFailureKindSchema,
  reason: boundedReason,
  retryDirective: Schema.Literal('NONE'),
}).check(
  Schema.makeFilter(({ finalAttempt, firstAttempt }) => {
    if (firstAttempt.attemptOrdinal !== 1 || finalAttempt.attemptOrdinal !== 2) {
      return 'Retry exhaustion requires exactly the first and second bounded attempts';
    }
    if (
      firstAttempt.runId !== finalAttempt.runId ||
      firstAttempt.candidateRef !== finalAttempt.candidateRef ||
      firstAttempt.attemptId === finalAttempt.attemptId ||
      firstAttempt.snapshot.snapshotId === finalAttempt.snapshot.snapshotId
    ) {
      return 'A bounded retry must rebuild a distinct whole attempt and coherent snapshot for the same run and candidate';
    }
    return firstAttempt.completedAt <= finalAttempt.startedAt
      ? undefined
      : 'The fresh retry cannot start before the discarded first attempt completes';
  }),
);

export const PricingCurrentnessEvaluationOutcomeSchema = Schema.Union([
  PricingFreshAttemptOutcomeSchema,
  PricingKnownStaleOrMaterialChangedOutcomeSchema,
  PricingKnownInvalidOrConflictOutcomeSchema,
  PricingIndeterminateOrUnverifiableOutcomeSchema,
  PricingRetryExhaustedOutcomeSchema,
]);
export type PricingCurrentnessEvaluationOutcome = typeof PricingCurrentnessEvaluationOutcomeSchema.Type;
