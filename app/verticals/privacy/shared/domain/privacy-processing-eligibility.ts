/* eslint-disable effect-native/no-unbranded-identifier-schema -- Privacy cross-owner wire contracts preserve explicit JSON null, canonical UTC string encodings, and owner-issued opaque references; generated API and Resource boundaries validate provenance without a misleading shared brand. expires: 2027-03-31. */
import { Schema } from 'effect';

import type { ConsentDecision } from './privacy-consent-decision.ts';
import {
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityEligibilityAuthorityResultSchema,
  PrivacyApplicabilityScopeSchema,
  privacyApplicabilityAuthorityMatchesExactUse,
} from './privacy-applicability.ts';
import type {
  PrivacyApplicabilityDecision,
  PrivacyApplicabilityEligibilityAuthorityResult,
  PrivacyApplicabilityScope,
} from './privacy-applicability.ts';
import {
  arePrivacyInstantsEqual,
  isPrivacyInstantAfter,
  isPrivacyInstantAtOrBefore,
  PrivacyIsoTimestampSchema,
} from './privacy-subject.ts';
import { ProcessingScopeRefSchema } from './privacy-responsibility-assignment.ts';
import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const RefList = Schema.Array(Ref).check(Schema.isMaxLength(64));
const InterventionKinds = Schema.Literals(['OBJECTION', 'RESTRICTION']);
export const PrivacyInterventionStatusSchema = Schema.Literals(['ACTIVE', 'RESOLVED', 'ABSENT']);
const PrivacyEligibilityDecisionOutcomeSchema = Schema.Literals(['ALLOWED', 'NOT_ALLOWED', 'INDETERMINATE']);

const privacyApplicabilityAuthorityEquivalent = Schema.toEquivalence(PrivacyApplicabilityAuthoritySchema);
const privacyApplicabilityScopeEquivalent = Schema.toEquivalence(PrivacyApplicabilityScopeSchema);

/** The complete business identity of the use being checked. Ambient request context is never added. */
export const IntendedProcessingScopeSchema = Schema.Struct({
  controllerRef: Ref,
  dataCategoryRefs: RefList,
  operation: Ref,
  processingScopeRef: ProcessingScopeRefSchema,
  purposeRef: Ref,
  purposeVersionId: Ref,
  recipientRefs: RefList,
  subjectRef: PrivacySubjectRefSchema,
});
export type IntendedProcessingScope = typeof IntendedProcessingScopeSchema.Type;

export const PrivacyInputCurrentnessSchema = Schema.Struct({
  authoritative: Schema.Boolean,
  observedAt: PrivacyIsoTimestampSchema,
  revision: Ref,
  sourceRef: Ref,
  validUntil: Schema.optional(PrivacyIsoTimestampSchema),
});
export type PrivacyInputCurrentness = typeof PrivacyInputCurrentnessSchema.Type;

export const PrivacyInputStateSchema = Schema.Literals(['CURRENT', 'ABSENT', 'STALE', 'UNAVAILABLE', 'CONFLICT']);
export type PrivacyInputState = typeof PrivacyInputStateSchema.Type;

export const PrivacyInputResolutionSchema = Schema.Struct({
  currentness: PrivacyInputCurrentnessSchema,
  reason: Ref,
  state: PrivacyInputStateSchema,
});
export type PrivacyInputResolution = typeof PrivacyInputResolutionSchema.Type;

export const PrivacyLegalBasisInputSchema = Schema.Struct({
  basisRef: Ref,
  basisVersion: Ref,
  currentness: PrivacyInputCurrentnessSchema,
  scope: IntendedProcessingScopeSchema,
});
export type PrivacyLegalBasisInput = typeof PrivacyLegalBasisInputSchema.Type;

export const PrivacyObjectionInputSchema = Schema.Struct({
  currentness: PrivacyInputCurrentnessSchema,
  objectionRef: Ref,
  scope: IntendedProcessingScopeSchema,
  status: PrivacyInterventionStatusSchema,
});
export type PrivacyObjectionInput = typeof PrivacyObjectionInputSchema.Type;

export const PrivacyRestrictionInputSchema = Schema.Struct({
  currentness: PrivacyInputCurrentnessSchema,
  restrictionRef: Ref,
  scope: IntendedProcessingScopeSchema,
  status: PrivacyInterventionStatusSchema,
});
export type PrivacyRestrictionInput = typeof PrivacyRestrictionInputSchema.Type;

/** Privacy-owned objection/restriction fact retained independently from Consent and Disposition. */
export const PrivacyProcessingInterventionSchema = Schema.Struct({
  currentness: PrivacyInputCurrentnessSchema,
  interventionRef: Ref,
  kind: InterventionKinds,
  scope: IntendedProcessingScopeSchema,
  status: PrivacyInterventionStatusSchema,
});
export type PrivacyProcessingIntervention = typeof PrivacyProcessingInterventionSchema.Type;

export const ProcessingInterventionAuthorityRequestSchema = Schema.Struct({
  interventionRef: Ref,
  kind: InterventionKinds,
  scope: IntendedProcessingScopeSchema,
});
export type ProcessingInterventionAuthorityRequest = typeof ProcessingInterventionAuthorityRequestSchema.Type;

export const ProcessingInterventionAuthorityResultSchema = Schema.Struct({
  actionInvocationId: Ref,
  asOf: PrivacyIsoTimestampSchema,
  authorityRef: Ref,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  intervention: PrivacyProcessingInterventionSchema,
  legalEntityId: Ref,
  receiptRef: Ref,
  tenantId: Ref,
});
export type ProcessingInterventionAuthorityResult = typeof ProcessingInterventionAuthorityResultSchema.Type;

type PrivacyScopedFact = Pick<PrivacyLegalBasisInput, 'currentness' | 'scope'>;
type PrivacyScopedStatusFact = Pick<PrivacyObjectionInput, 'currentness' | 'scope' | 'status'>;

export interface ResolvePrivacyEligibilityInputsInput {
  readonly applicability: PrivacyApplicabilityDecision | null;
  readonly applicabilityCurrentness: PrivacyInputCurrentness | null;
  /** Trusted exact scope that the Applicability Decision must have evaluated. */
  readonly applicabilityScope: PrivacyApplicabilityScope;
  readonly asOf: string;
  readonly consent: ConsentDecision | null;
  readonly consentCurrentness: PrivacyInputCurrentness | null;
  readonly intendedScope: IntendedProcessingScope;
  readonly legalBasis: PrivacyLegalBasisInput | null;
  readonly legalEntityId: string;
  readonly objection: PrivacyObjectionInput | null;
  readonly restriction: PrivacyRestrictionInput | null;
  readonly tenantId: string;
}

const exactStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    left.every((value) => rightSet.has(value))
  );
};

const factValues = (scope: PrivacyApplicabilityScope, dimension: string): readonly string[] =>
  (() => {
    const values: string[] = [];
    for (const fact of scope.facts) {
      if (fact.dimension === dimension) {
        values.push(fact.value);
      }
    }
    return values;
  })();

const exactIntendedApplicabilityFacts = (scope: IntendedProcessingScope): ReadonlyMap<string, readonly string[]> =>
  new Map([
    ['CATEGORY', scope.dataCategoryRefs],
    ['CONTROLLER_SCOPE', [scope.controllerRef]],
    ['PRIVACY_SUBJECT', [scope.subjectRef.resourceId]],
    ['PROCESSING_PURPOSE', [scope.purposeRef]],
    ['PROCESSING_PURPOSE_VERSION', [scope.purposeVersionId]],
    ['RECIPIENT', scope.recipientRefs],
  ]);

const applicabilityScopeMatchesExactIntendedUse = (
  applicabilityScope: PrivacyApplicabilityScope,
  intendedScope: IntendedProcessingScope,
): boolean =>
  applicabilityScope.operation === intendedScope.operation &&
  applicabilityScope.processingScopeRef.scopeId === intendedScope.processingScopeRef.scopeId &&
  applicabilityScope.processingScopeRef.scopeType === intendedScope.processingScopeRef.scopeType &&
  [...exactIntendedApplicabilityFacts(intendedScope)].every(([dimension, expected]) =>
    exactStringSet(factValues(applicabilityScope, dimension), expected),
  );

const authorityEvidenceExactlyMatches = (
  decision: PrivacyApplicabilityDecision,
  authorityResult: PrivacyApplicabilityEligibilityAuthorityResult,
): boolean =>
  decision.authorityEvidenceRefs !== undefined &&
  exactStringSet(decision.authorityEvidenceRefs, authorityResult.evidenceRefs);

const validateApplicabilityAuthorityCurrentness = (input: {
  readonly asOf: string;
  readonly authorityResult: PrivacyApplicabilityEligibilityAuthorityResult;
}): string | undefined => {
  const { asOf, authorityResult } = input;
  if (!Schema.is(PrivacyApplicabilityEligibilityAuthorityResultSchema)(authorityResult)) {
    return 'Applicability eligibility authority returned an invalid currentness receipt';
  }
  if (authorityResult.status !== 'CURRENT') {
    return `Applicability eligibility authority is ${authorityResult.status.toLowerCase()}`;
  }
  if (!arePrivacyInstantsEqual(authorityResult.asOf, asOf)) {
    return 'Applicability eligibility authority does not match the exact as-of instant';
  }
  if (!isPrivacyInstantAtOrBefore(authorityResult.decisionEvaluatedAt, asOf)) {
    return 'Applicability eligibility authority returned a future decision';
  }
  if (authorityResult.validUntil === undefined) {
    return arePrivacyInstantsEqual(authorityResult.decisionEvaluatedAt, asOf)
      ? undefined
      : 'Historical Applicability Decisions require an authority validUntil';
  }
  return isPrivacyInstantAfter(authorityResult.validUntil, asOf)
    ? undefined
    : 'Applicability eligibility authority receipt is expired at the exact as-of instant';
};

const validateApplicabilityAuthorityIdentity = (input: {
  readonly authorityResult: PrivacyApplicabilityEligibilityAuthorityResult;
  readonly intendedScope: IntendedProcessingScope;
  readonly legalEntityId: string;
  readonly tenantId: string;
}): string | undefined => {
  const { authorityResult, intendedScope, legalEntityId, tenantId } = input;
  return privacyApplicabilityAuthorityMatchesExactUse(authorityResult.authority, {
    controllerRef: intendedScope.controllerRef,
    legalEntityId,
    purposeRef: intendedScope.purposeRef,
    purposeVersionId: intendedScope.purposeVersionId,
    tenantId,
  }) && intendedScope.subjectRef.tenantId === tenantId
    ? undefined
    : 'Applicability eligibility authority does not match the exact Tenant, Legal Entity, Controller, or Purpose';
};

const validatePersistedApplicabilityDecision = (input: {
  readonly authorityResult: PrivacyApplicabilityEligibilityAuthorityResult;
  readonly decision: PrivacyApplicabilityDecision;
  readonly decisionRef: string;
  readonly intendedScope: IntendedProcessingScope;
}): string | undefined => {
  const { authorityResult, decision, decisionRef, intendedScope } = input;
  if (!applicabilityScopeMatchesExactIntendedUse(authorityResult.scope, intendedScope)) {
    return 'Applicability eligibility authority facts do not match the exact intended use';
  }
  if (decisionRef !== authorityResult.decisionRef) {
    return 'Persisted Applicability Decision is not the decision confirmed by authority';
  }
  if (decision.outcome !== authorityResult.decisionOutcome) {
    return 'Persisted Applicability Decision outcome is not confirmed by authority';
  }
  if (!arePrivacyInstantsEqual(decision.evaluatedAt, authorityResult.decisionEvaluatedAt)) {
    return 'Persisted Applicability Decision time is not confirmed by authority';
  }
  if (!privacyApplicabilityScopeEquivalent(decision.evaluatedScope, authorityResult.scope)) {
    return 'Persisted Applicability Decision scope is not confirmed by authority';
  }
  if (
    decision.authority === undefined ||
    !privacyApplicabilityAuthorityEquivalent(decision.authority, authorityResult.authority)
  ) {
    return 'Persisted Applicability Decision authority is not confirmed by authority';
  }
  return authorityEvidenceExactlyMatches(decision, authorityResult) &&
    decision.authorityReceiptRef === authorityResult.receiptRef
    ? undefined
    : 'Persisted Applicability Decision receipt is not confirmed by authority';
};

/**
 * Confirms that an eligibility authority re-resolved the exact current use
 * before a stored Applicability Decision can participate in ALLOWED.
 */
export const validatePrivacyApplicabilityEligibilityAuthorityResult = (input: {
  readonly asOf: string;
  readonly authorityResult: PrivacyApplicabilityEligibilityAuthorityResult;
  readonly decision: PrivacyApplicabilityDecision;
  readonly decisionRef: string;
  readonly intendedScope: IntendedProcessingScope;
  readonly legalEntityId: string;
  readonly tenantId: string;
}): string | undefined => {
  const { asOf, authorityResult, decision, decisionRef, intendedScope, legalEntityId, tenantId } = input;
  return (
    validateApplicabilityAuthorityCurrentness({ asOf, authorityResult }) ??
    validateApplicabilityAuthorityIdentity({ authorityResult, intendedScope, legalEntityId, tenantId }) ??
    validatePersistedApplicabilityDecision({ authorityResult, decision, decisionRef, intendedScope })
  );
};

export interface PrivacyEligibilityInputResolutions {
  readonly applicability: PrivacyInputResolution;
  readonly consent: PrivacyInputResolution;
  readonly legalBasis: PrivacyInputResolution;
  readonly objection: PrivacyInputResolution;
  readonly restriction: PrivacyInputResolution;
}

export const PrivacyEligibilityOutcomeSchema = Schema.Struct({
  evaluatedAt: PrivacyIsoTimestampSchema,
  evaluatedScope: IntendedProcessingScopeSchema,
  inputResolutions: Schema.Struct({
    applicability: PrivacyInputResolutionSchema,
    consent: PrivacyInputResolutionSchema,
    legalBasis: PrivacyInputResolutionSchema,
    objection: PrivacyInputResolutionSchema,
    restriction: PrivacyInputResolutionSchema,
  }),
  outcome: PrivacyEligibilityDecisionOutcomeSchema,
  reasonCodes: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
export type PrivacyEligibilityOutcome = typeof PrivacyEligibilityOutcomeSchema.Type;

/** A versioned policy identity retained for historical explanation, never as an authorization token. */
export const PrivacyEligibilityPolicyRevisionSchema = Schema.Struct({
  policyRef: Ref,
  revision: Ref,
});
export type PrivacyEligibilityPolicyRevision = typeof PrivacyEligibilityPolicyRevisionSchema.Type;

/** Safe references only. The registry owns the referenced fact and its payload lifecycle. */
export const PrivacyEligibilityAuthoritativeReferenceSchema = Schema.Struct({
  kind: Ref,
  reference: Ref,
  revision: Ref,
});
export type PrivacyEligibilityAuthoritativeReference = typeof PrivacyEligibilityAuthoritativeReferenceSchema.Type;

export const PrivacyEligibilityCurrentnessConditionSchema = Schema.Struct({
  authoritative: Schema.Boolean,
  input: Ref,
  observedAt: PrivacyIsoTimestampSchema,
  revision: Ref,
  sourceRef: Ref,
  state: PrivacyInputStateSchema,
  validUntil: Schema.optional(PrivacyIsoTimestampSchema),
});
export type PrivacyEligibilityCurrentnessCondition = typeof PrivacyEligibilityCurrentnessConditionSchema.Type;

/** A consumer owns this declaration; Privacy never invents a universal freshness window. */
export const PrivacyEligibilityConsumerContractSchema = Schema.Struct({
  consumerRef: Ref,
  invalidationBehavior: Schema.Literals(['STOP_BEFORE_BOUNDARY', 'RECHECK_BEFORE_BOUNDARY']),
  lastControllableBoundary: Ref,
  operationRef: Ref,
  recheckRequiredAtBoundary: Schema.Boolean,
});
export type PrivacyEligibilityConsumerContract = typeof PrivacyEligibilityConsumerContractSchema.Type;

export const PrivacyEligibilityBoundaryResultSchema = Schema.Literals([
  'REUSE_ALLOWED',
  'RECHECK_REQUIRED',
  'INVALIDATED',
  'STOPPED',
]);
export type PrivacyEligibilityBoundaryResult = typeof PrivacyEligibilityBoundaryResultSchema.Type;

export const PrivacyEligibilityBoundaryAssessmentSchema = Schema.Struct({
  boundary: Ref,
  consumerRef: Ref,
  decisionRevision: Ref,
  reason: Ref,
  result: PrivacyEligibilityBoundaryResultSchema,
});
export type PrivacyEligibilityBoundaryAssessment = typeof PrivacyEligibilityBoundaryAssessmentSchema.Type;

export const PrivacyEligibilityHandoffSchema = Schema.Struct({
  consumerRef: Ref,
  decisionRevision: Ref,
  handoffRef: Ref,
  operationRef: Ref,
  status: Schema.Literals(['PENDING', 'COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED']),
});
export type PrivacyEligibilityHandoff = typeof PrivacyEligibilityHandoffSchema.Type;

/** Durable explainability for one evaluation. It contains no personal-data payload copy. */
export const PrivacyEligibilityEvidenceSchema = Schema.Struct({
  authoritativeReferences: Schema.Array(PrivacyEligibilityAuthoritativeReferenceSchema).check(Schema.isMaxLength(64)),
  currentnessConditions: Schema.Array(PrivacyEligibilityCurrentnessConditionSchema).check(Schema.isMaxLength(8)),
  evaluatedScope: IntendedProcessingScopeSchema,
  outcome: PrivacyEligibilityDecisionOutcomeSchema,
  policyRevisions: Schema.Array(PrivacyEligibilityPolicyRevisionSchema).check(Schema.isMaxLength(16)),
  reasonCodes: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  trustedDecisionTime: PrivacyIsoTimestampSchema,
});
export type PrivacyEligibilityEvidence = typeof PrivacyEligibilityEvidenceSchema.Type;

export interface CreatePrivacyEligibilityEvidenceInput {
  readonly authoritativeReferences?: readonly PrivacyEligibilityAuthoritativeReference[] | undefined;
  readonly outcome: PrivacyEligibilityOutcome;
  readonly policyRevisions?: readonly PrivacyEligibilityPolicyRevision[] | undefined;
}

const toCurrentnessCondition = ([input, resolution]: readonly [
  string,
  PrivacyInputResolution,
]): PrivacyEligibilityCurrentnessCondition => {
  const condition: PrivacyEligibilityCurrentnessCondition = {
    authoritative: resolution.currentness.authoritative,
    input,
    observedAt: resolution.currentness.observedAt,
    revision: resolution.currentness.revision,
    sourceRef: resolution.currentness.sourceRef,
    state: resolution.state,
  };
  return resolution.currentness.validUntil === undefined
    ? condition
    : { ...condition, validUntil: resolution.currentness.validUntil };
};

/** Freezes the decision inputs needed to explain a historical result without copying their payloads. */
export const createPrivacyEligibilityEvidence = (
  input: CreatePrivacyEligibilityEvidenceInput,
): PrivacyEligibilityEvidence => ({
  authoritativeReferences: [...(input.authoritativeReferences ?? [])],
  currentnessConditions: Object.entries(input.outcome.inputResolutions).map(toCurrentnessCondition),
  evaluatedScope: input.outcome.evaluatedScope,
  outcome: input.outcome.outcome,
  policyRevisions: [...(input.policyRevisions ?? [])],
  reasonCodes: [...input.outcome.reasonCodes],
  trustedDecisionTime: input.outcome.evaluatedAt,
});

const stableKey = (parts: readonly string[]): string => parts.map((part) => `${String(part.length)}:${part}`).join('|');

const applicabilityScopeKey = (scope: PrivacyApplicabilityScope): string =>
  stableKey([
    scope.operation,
    scope.processingScopeRef.scopeId,
    scope.processingScopeRef.scopeType,
    stableKey(
      scope.facts
        .map(({ dimension, value }) => stableKey([dimension, value]))
        .toSorted((left, right) => left.localeCompare(right)),
    ),
  ]);

const currentnessRevision = (outcome: PrivacyEligibilityOutcome): string =>
  stableKey(
    Object.entries(outcome.inputResolutions)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .flatMap(([input, resolution]) => [
        input,
        resolution.state,
        resolution.currentness.revision,
        resolution.currentness.sourceRef,
      ]),
  );

const scopeKey = (scope: IntendedProcessingScope): string =>
  stableKey([
    scope.controllerRef,
    stableKey(scope.dataCategoryRefs.toSorted()),
    scope.operation,
    scope.subjectRef.moduleId,
    scope.subjectRef.resourceId,
    scope.subjectRef.resourceType,
    scope.subjectRef.tenantId,
    scope.processingScopeRef.scopeId,
    scope.processingScopeRef.scopeType,
    scope.purposeRef,
    scope.purposeVersionId,
    stableKey(scope.recipientRefs.toSorted()),
  ]);

/** Stable revision for comparing a decision at a later consumer boundary. */
export const privacyEligibilityDecisionRevision = (outcome: PrivacyEligibilityOutcome): string =>
  `eligibility:${stableKey([scopeKey(outcome.evaluatedScope), currentnessRevision(outcome)])}`;

/**
 * Checks whether a previously evaluated decision can cross a consumer's final
 * controllable boundary. A pending invalidation event is never treated as proof
 * of safety; the caller must supply a fresh authoritative evaluation when the
 * contract requires a recheck.
 */
// fallow-ignore-next-line complexity -- Consumer-boundary assessment explicitly handles every stale, invalidated, mismatched, and fail-closed state.
export const assessPrivacyEligibilityBoundary = (input: {
  readonly boundary: string;
  readonly contract: PrivacyEligibilityConsumerContract;
  readonly decision: PrivacyEligibilityOutcome;
  readonly decisionRevision?: string;
  readonly invalidated?: boolean;
  readonly latest?: PrivacyEligibilityOutcome;
}): PrivacyEligibilityBoundaryAssessment => {
  const revision = input.decisionRevision ?? privacyEligibilityDecisionRevision(input.decision);
  if (input.contract.operationRef !== input.decision.evaluatedScope.operation) {
    return {
      boundary: input.boundary,
      consumerRef: input.contract.consumerRef,
      decisionRevision: revision,
      reason: 'operation_not_evaluated_for_consumer',
      result: 'STOPPED',
    };
  }
  if (input.boundary !== input.contract.lastControllableBoundary) {
    return {
      boundary: input.boundary,
      consumerRef: input.contract.consumerRef,
      decisionRevision: revision,
      reason: 'boundary_not_declared_by_consumer',
      result: 'STOPPED',
    };
  }
  if (input.invalidated === true) {
    return {
      boundary: input.boundary,
      consumerRef: input.contract.consumerRef,
      decisionRevision: revision,
      reason: 'decision_invalidated_before_controllable_boundary',
      result: input.contract.invalidationBehavior === 'RECHECK_BEFORE_BOUNDARY' ? 'RECHECK_REQUIRED' : 'INVALIDATED',
    };
  }
  if (input.latest === undefined && input.contract.recheckRequiredAtBoundary) {
    return {
      boundary: input.boundary,
      consumerRef: input.contract.consumerRef,
      decisionRevision: revision,
      reason: 'required_boundary_recheck_missing',
      result: 'RECHECK_REQUIRED',
    };
  }
  if (input.latest !== undefined) {
    if (input.latest.outcome !== 'ALLOWED') {
      return {
        boundary: input.boundary,
        consumerRef: input.contract.consumerRef,
        decisionRevision: privacyEligibilityDecisionRevision(input.latest),
        reason: `latest_eligibility_${input.latest.outcome.toLowerCase()}`,
        result: 'INVALIDATED',
      };
    }
    if (privacyEligibilityDecisionRevision(input.latest) !== revision) {
      return {
        boundary: input.boundary,
        consumerRef: input.contract.consumerRef,
        decisionRevision: privacyEligibilityDecisionRevision(input.latest),
        reason: 'eligibility_inputs_changed_before_boundary',
        result: 'RECHECK_REQUIRED',
      };
    }
  }
  return {
    boundary: input.boundary,
    consumerRef: input.contract.consumerRef,
    decisionRevision: revision,
    reason: 'authoritative_decision_current_at_declared_boundary',
    result: 'REUSE_ALLOWED',
  };
};

/** An uncertain handoff is durable and must be reconciled before a retry. */
export const reconcilePrivacyEligibilityHandoff = (input: {
  readonly authoritativeDecisionRevision?: string;
  readonly handoff: PrivacyEligibilityHandoff;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
}): PrivacyEligibilityHandoff => {
  if (input.handoff.status === 'COMPLETED' || input.handoff.status === 'FAILED') {
    return input.handoff;
  }
  if (input.outcome === 'INDETERMINATE') {
    return { ...input.handoff, status: 'RECONCILIATION_REQUIRED' };
  }
  if (input.outcome === 'SUCCEEDED' && input.authoritativeDecisionRevision === undefined) {
    return { ...input.handoff, status: 'RECONCILIATION_REQUIRED' };
  }
  if (
    input.authoritativeDecisionRevision !== undefined &&
    input.authoritativeDecisionRevision !== input.handoff.decisionRevision
  ) {
    return { ...input.handoff, status: 'RECONCILIATION_REQUIRED' };
  }
  return { ...input.handoff, status: input.outcome === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED' };
};

const absent = (reason: string, asOf: string): PrivacyInputResolution => ({
  currentness: {
    authoritative: false,
    observedAt: asOf,
    revision: 'none',
    sourceRef: 'none',
  },
  reason,
  state: 'ABSENT',
});

const currentness = (value: PrivacyInputCurrentness | null, asOf: string): PrivacyInputResolution => {
  if (value === null) {
    return absent('input_absent', asOf);
  }
  if (!value.authoritative) {
    return { currentness: value, reason: 'source_not_authoritative', state: 'UNAVAILABLE' };
  }
  if (!isPrivacyInstantAtOrBefore(value.observedAt, asOf)) {
    return { currentness: value, reason: 'observed_after_evaluation_time', state: 'CONFLICT' };
  }
  if (value.validUntil !== undefined && !isPrivacyInstantAfter(value.validUntil, asOf)) {
    return { currentness: value, reason: 'input_expired', state: 'STALE' };
  }
  return { currentness: value, reason: 'authoritative_current_input', state: 'CURRENT' };
};

const scopeMismatch = (reason: string, asOf: string): PrivacyInputResolution => ({
  currentness: { authoritative: false, observedAt: asOf, revision: 'mismatch', sourceRef: 'scope' },
  reason,
  state: 'STALE',
});

const resolveApplicabilityInput = (input: ResolvePrivacyEligibilityInputsInput): PrivacyInputResolution => {
  const resolution = currentness(input.applicabilityCurrentness, input.asOf);
  if (input.applicability === null) {
    return resolution;
  }
  const applicabilityTargetsIntendedScope =
    input.applicabilityScope.operation === input.intendedScope.operation &&
    input.applicabilityScope.processingScopeRef.scopeId === input.intendedScope.processingScopeRef.scopeId &&
    input.applicabilityScope.processingScopeRef.scopeType === input.intendedScope.processingScopeRef.scopeType;
  const exactScopeMatch =
    applicabilityScopeKey(input.applicability.evaluatedScope) === applicabilityScopeKey(input.applicabilityScope);
  if (!applicabilityTargetsIntendedScope || !exactScopeMatch) {
    return scopeMismatch('applicability_scope_mismatch', input.asOf);
  }
  const { authority } = input.applicability;
  if (
    authority === undefined ||
    !privacyApplicabilityAuthorityMatchesExactUse(authority, {
      controllerRef: input.intendedScope.controllerRef,
      legalEntityId: input.legalEntityId,
      purposeRef: input.intendedScope.purposeRef,
      purposeVersionId: input.intendedScope.purposeVersionId,
      tenantId: input.tenantId,
    })
  ) {
    return scopeMismatch('applicability_authority_mismatch', input.asOf);
  }
  return resolution;
};

const resolveScopedInput = (
  fact: PrivacyScopedFact | null,
  absentReason: string,
  expectedScopeKey: string,
  mismatchReason: string,
  asOf: string,
): PrivacyInputResolution => {
  if (fact === null) {
    return absent(absentReason, asOf);
  }
  return scopeKey(fact.scope) === expectedScopeKey
    ? currentness(fact.currentness, asOf)
    : scopeMismatch(mismatchReason, asOf);
};

const consentMatchesScope = (input: ResolvePrivacyEligibilityInputsInput): boolean => {
  if (input.consent === null) {
    return false;
  }
  return (
    input.consent.scope.controllerRef === input.intendedScope.controllerRef &&
    input.consent.scope.scopeRef === input.intendedScope.processingScopeRef.scopeId &&
    input.consent.scope.processingPurposeRef.resourceId === input.intendedScope.purposeRef &&
    input.consent.scope.purposeVersionRef === input.intendedScope.purposeVersionId
  );
};

const resolveConsentInput = (input: ResolvePrivacyEligibilityInputsInput): PrivacyInputResolution => {
  if (input.consent === null) {
    return absent('consent_absent', input.asOf);
  }
  return consentMatchesScope(input)
    ? currentness(input.consentCurrentness, input.asOf)
    : scopeMismatch('consent_scope_mismatch', input.asOf);
};

/** Resolves input facts only. It does not decide eligibility or execute a consumer operation. */
export const resolvePrivacyEligibilityInputs = (
  input: ResolvePrivacyEligibilityInputsInput,
): PrivacyEligibilityInputResolutions => {
  const expected = scopeKey(input.intendedScope);
  return {
    applicability: resolveApplicabilityInput(input),
    consent: resolveConsentInput(input),
    legalBasis: resolveScopedInput(
      input.legalBasis,
      'legal_basis_absent',
      expected,
      'legal_basis_scope_mismatch',
      input.asOf,
    ),
    objection: resolveScopedInput(
      input.objection,
      'objection_absent',
      expected,
      'objection_scope_mismatch',
      input.asOf,
    ),
    restriction: resolveScopedInput(
      input.restriction,
      'restriction_absent',
      expected,
      'restriction_scope_mismatch',
      input.asOf,
    ),
  };
};

export const isReliableCurrentPrivacyInput = (resolution: PrivacyInputResolution): boolean =>
  resolution.state === 'CURRENT';

const consentIsRequired = (basisRef: string): boolean =>
  basisRef === 'legal-basis:consent' || basisRef.endsWith(':consent');

const reliableConsentBlocker = (
  input: ResolvePrivacyEligibilityInputsInput,
  resolutions: PrivacyEligibilityInputResolutions,
): string | undefined => {
  if (resolutions.consent.state !== 'CURRENT' || input.consent === null) {
    return undefined;
  }
  return input.consent.decision === 'REFUSED' || input.consent.decision === 'WITHDRAWN'
    ? `consent_${input.consent.decision.toLowerCase()}`
    : undefined;
};

const reliableStateBlocker = (
  resolution: PrivacyInputResolution,
  fact: PrivacyScopedStatusFact | null,
  reason: string,
): string | undefined => (resolution.state === 'CURRENT' && fact?.status === 'ACTIVE' ? reason : undefined);

const definedReasons = (reasons: readonly (string | undefined)[]): string[] =>
  reasons.filter((reason): reason is string => reason !== undefined);

const eligibilityBlockers = (
  input: ResolvePrivacyEligibilityInputsInput,
  resolutions: PrivacyEligibilityInputResolutions,
): string[] =>
  definedReasons([
    reliableConsentBlocker(input, resolutions),
    reliableStateBlocker(resolutions.objection, input.objection, 'processing_objection_active'),
    reliableStateBlocker(resolutions.restriction, input.restriction, 'processing_restriction_active'),
  ]);

const applicabilityUnknownReason = (
  input: ResolvePrivacyEligibilityInputsInput,
  resolution: PrivacyInputResolution,
): string | undefined => {
  if (resolution.state !== 'CURRENT') {
    return `applicability_${resolution.reason}`;
  }
  return input.applicability?.outcome === 'APPLICABLE'
    ? undefined
    : `applicability_outcome_${input.applicability?.outcome.toLowerCase() ?? 'absent'}`;
};

const consentUnknownReason = (
  input: ResolvePrivacyEligibilityInputsInput,
  resolution: PrivacyInputResolution,
): string | undefined => {
  if (input.legalBasis === null || !consentIsRequired(input.legalBasis.basisRef)) {
    return undefined;
  }
  return resolution.state === 'CURRENT' ? undefined : `consent_${resolution.reason}`;
};

const interventionUnknownReason = (
  input: 'objection' | 'restriction',
  resolution: PrivacyInputResolution,
): string | undefined => (resolution.state === 'CURRENT' ? undefined : `${input}_${resolution.reason}`);

const eligibilityUnknownReasons = (
  input: ResolvePrivacyEligibilityInputsInput,
  resolutions: PrivacyEligibilityInputResolutions,
): string[] =>
  definedReasons([
    applicabilityUnknownReason(input, resolutions.applicability),
    resolutions.legalBasis.state === 'CURRENT' ? undefined : `legal_basis_${resolutions.legalBasis.reason}`,
    consentUnknownReason(input, resolutions.consent),
    interventionUnknownReason('objection', resolutions.objection),
    interventionUnknownReason('restriction', resolutions.restriction),
  ]);

/**
 * Resolves one complete, exact-scope eligibility outcome. It only evaluates privacy
 * policy facts; it never performs the intended operation or grants authorization.
 */
export const evaluatePrivacyEligibility = (input: ResolvePrivacyEligibilityInputsInput): PrivacyEligibilityOutcome => {
  const inputResolutions = resolvePrivacyEligibilityInputs(input);
  const blockers = eligibilityBlockers(input, inputResolutions);

  // A reliable blocker is decisive only because input resolution proved its exact scope.
  if (blockers.length > 0) {
    return {
      evaluatedAt: input.asOf,
      evaluatedScope: input.intendedScope,
      inputResolutions,
      outcome: 'NOT_ALLOWED',
      reasonCodes: blockers,
    };
  }

  const unknown = eligibilityUnknownReasons(input, inputResolutions);

  return {
    evaluatedAt: input.asOf,
    evaluatedScope: input.intendedScope,
    inputResolutions,
    outcome: unknown.length > 0 ? 'INDETERMINATE' : 'ALLOWED',
    reasonCodes: unknown.length > 0 ? unknown : ['all_mandatory_inputs_current_no_blocker'],
  };
};
