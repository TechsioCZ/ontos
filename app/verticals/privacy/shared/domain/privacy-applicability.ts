/* eslint-disable effect-native/no-unbranded-identifier-schema -- Privacy authority refs are decoded opaque cross-owner wire identities; their tenant/resource provenance is enforced by exact typed-reference checks. expires: 2027-03-31. */
import { DateTime, Option, Schema } from 'effect';

import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';
import { PrivacyOwnerResourceRefSchema } from './privacy-owner-resource-ref.ts';
import type { ProcessingScopeRef } from './privacy-responsibility-assignment.ts';
import type { PrivacyResponsibilityAssignmentRef } from '../resources/privacy-responsibility-assignment.ts';
import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { ProcessingScopeRefSchema } from './privacy-responsibility-assignment.ts';

const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Version = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const PolicyKeySchema = Text.pipe(Schema.brand('PrivacyApplicabilityPolicyKey'));
const ScopeKeySchema = Text.pipe(Schema.brand('PrivacyApplicabilityScopeKey'));

const PrivacyApplicabilityDimensionSchema = Schema.Literals([
  'CATEGORY',
  'CHANNEL',
  'CONTROLLER_SCOPE',
  'INTENDED_USE',
  'JURISDICTION',
  'PROCESSING_PURPOSE',
  'PROCESSING_PURPOSE_VERSION',
  'PRIVACY_SUBJECT',
  'RECIPIENT',
  'SITE',
  'TENANT',
]);
type PrivacyApplicabilityDimension = typeof PrivacyApplicabilityDimensionSchema.Type;

/** A governed profile is configuration data, not a type-level universal. */
export const PrivacyApplicabilityProfileRefSchema = Schema.Struct({
  profileKey: PolicyKeySchema,
  profileVersion: Version,
});
export type PrivacyApplicabilityProfileRef = typeof PrivacyApplicabilityProfileRefSchema.Type;

export const PrivacyApplicabilityFactPredicateSchema = Schema.Struct({
  dimension: PrivacyApplicabilityDimensionSchema,
  operator: Schema.Literals(['EQUALS', 'ONE_OF']),
  values: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type PrivacyApplicabilityFactPredicate = typeof PrivacyApplicabilityFactPredicateSchema.Type;

const PrivacyApplicabilityFactSchema = Schema.Struct({
  dimension: PrivacyApplicabilityDimensionSchema,
  value: Text,
});

const PrivacyPurposeVersionRefSchema = Schema.Struct({
  moduleId: Schema.Literal('privacy.core'),
  resourceId: Schema.String.check(Schema.isUUID()),
  resourceType: Schema.Literal('privacy.core.processing-purpose-version'),
  tenantId: Schema.String.check(Schema.isUUID()),
});

export const PrivacyApplicabilityAuthoritySchema = Schema.Struct({
  controllerRef: PrivacyOwnerResourceRefSchema,
  legalEntityId: Schema.String.check(Schema.isUUID()),
  purposeRef: ProcessingPurposeRefSchema,
  purposeVersionRef: PrivacyPurposeVersionRefSchema,
  tenantId: Schema.String.check(Schema.isUUID()),
});
export type PrivacyApplicabilityAuthority = typeof PrivacyApplicabilityAuthoritySchema.Type;

const PrivacyApplicabilityDecisionOutcomeSchema = Schema.Literals(['APPLICABLE', 'UNRESOLVED', 'CONFLICT']);

export const privacyApplicabilityAuthorityMatchesExactUse = (
  authority: PrivacyApplicabilityAuthority,
  expected: Readonly<{
    controllerRef: string;
    legalEntityId: string;
    purposeRef: string;
    purposeVersionId: string;
    tenantId: string;
  }>,
): boolean =>
  authority.tenantId === expected.tenantId &&
  authority.legalEntityId === expected.legalEntityId &&
  authority.controllerRef.tenantId === expected.tenantId &&
  authority.controllerRef.resourceId === expected.controllerRef &&
  authority.purposeRef.tenantId === expected.tenantId &&
  authority.purposeRef.resourceId === expected.purposeRef &&
  authority.purposeVersionRef.tenantId === expected.tenantId &&
  authority.purposeVersionRef.resourceId === expected.purposeVersionId;

/** The scope is deliberately a caller-declared, stable business scope, not an inferred request context. */
export const PrivacyApplicabilityScopeSchema = Schema.Struct({
  facts: Schema.Array(PrivacyApplicabilityFactSchema).check(Schema.isMaxLength(32)),
  operation: Text,
  processingScopeRef: ProcessingScopeRefSchema,
});
export type PrivacyApplicabilityScope = typeof PrivacyApplicabilityScopeSchema.Type;

/** Public Action input: identity of the processing scope, never its business facts. */
export const PrivacyApplicabilityScopeIntentSchema = Schema.Struct({
  operation: Text,
  processingScopeRef: ProcessingScopeRefSchema,
});
export type PrivacyApplicabilityScopeIntent = typeof PrivacyApplicabilityScopeIntentSchema.Type;

export const PrivacyApplicabilityPolicySchema = Schema.Struct({
  composition: Schema.Struct({
    precedence: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    strategy: Schema.Literal('EXPLICIT_PRECEDENCE'),
  }),
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  factPredicates: Schema.Array(PrivacyApplicabilityFactPredicateSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  jurisdictionProfile: PrivacyApplicabilityProfileRefSchema,
  mandatoryDimensions: Schema.Array(PrivacyApplicabilityDimensionSchema).check(Schema.isMaxLength(16)),
  policyKey: PolicyKeySchema,
  policyVersion: Version,
  scopeKey: ScopeKeySchema,
  sourceEvidenceRefs: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter((policy) => {
    if (policy.effectiveTo !== null && policy.effectiveTo <= policy.effectiveFrom) {
      return 'Applicability policy effective period is invalid';
    }
    if (new Set(policy.mandatoryDimensions).size !== policy.mandatoryDimensions.length) {
      return 'Applicability policy mandatory dimensions must be unique';
    }
    const predicateDimensions = new Set(policy.factPredicates.map(({ dimension }) => dimension));
    return policy.mandatoryDimensions.every((dimension) => predicateDimensions.has(dimension))
      ? undefined
      : 'Applicability policy must define a predicate for every mandatory dimension';
  }),
);
export type PrivacyApplicabilityPolicy = typeof PrivacyApplicabilityPolicySchema.Type;

export const PrivacyApplicabilityDecisionSchema = Schema.Struct({
  /** Missing only on retained legacy decisions, which may not authorize new writes. */
  authority: Schema.optionalKey(PrivacyApplicabilityAuthoritySchema),
  /** Missing on legacy decisions; new eligibility reuse requires the exact authority receipt. */
  authorityEvidenceRefs: Schema.optionalKey(Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32))),
  /** Missing on legacy decisions; new eligibility reuse requires the exact authority receipt. */
  authorityReceiptRef: Schema.optionalKey(Text),
  evaluatedAt: PrivacyIsoTimestampSchema,
  evaluatedScope: PrivacyApplicabilityScopeSchema,
  evidenceRefs: Schema.Array(Text).check(Schema.isMaxLength(32)),
  outcome: PrivacyApplicabilityDecisionOutcomeSchema,
  policyIdentities: Schema.Array(
    Schema.Struct({
      jurisdictionProfile: Schema.optional(PrivacyApplicabilityProfileRefSchema),
      policyKey: PolicyKeySchema,
      policyVersion: Version,
    }),
  ).check(Schema.isMaxLength(16)),
  proposedActivity: Schema.Boolean,
  reasonCodes: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(Schema.isMaxLength(32)),
});
export type PrivacyApplicabilityDecision = typeof PrivacyApplicabilityDecisionSchema.Type;

/** Exact-use identity sent to the trusted applicability authority; it contains no business facts. */
export const PrivacyApplicabilityEligibilityUseSchema = Schema.Struct({
  controllerRef: Text,
  dataCategoryRefs: Schema.Array(Text).check(Schema.isMaxLength(64)),
  operation: Text,
  processingScopeRef: ProcessingScopeRefSchema,
  purposeRef: Text,
  purposeVersionId: Text,
  recipientRefs: Schema.Array(Text).check(Schema.isMaxLength(64)),
  subjectRef: PrivacySubjectRefSchema,
});
export type PrivacyApplicabilityEligibilityUse = typeof PrivacyApplicabilityEligibilityUseSchema.Type;

/** Trusted confirmation of the current facts and the exact stored decision used by eligibility. */
export const PrivacyApplicabilityEligibilityAuthorityResultSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  authority: PrivacyApplicabilityAuthoritySchema,
  decisionEvaluatedAt: PrivacyIsoTimestampSchema,
  decisionOutcome: PrivacyApplicabilityDecisionOutcomeSchema,
  decisionRef: Text,
  evidenceRefs: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  receiptRef: Text,
  scope: PrivacyApplicabilityScopeSchema,
  status: Schema.Literals(['CURRENT', 'STALE', 'CONFLICT']),
  validUntil: Schema.optionalKey(PrivacyIsoTimestampSchema),
});
export type PrivacyApplicabilityEligibilityAuthorityResult =
  typeof PrivacyApplicabilityEligibilityAuthorityResultSchema.Type;

export type PrivacyApplicabilityResolution =
  | { readonly decision: PrivacyApplicabilityDecision; readonly outcome: 'CURRENT' }
  | { readonly outcome: 'ABSENT' }
  | { readonly decisions: readonly PrivacyApplicabilityDecision[]; readonly outcome: 'CONFLICT' };

export interface ResolvePrivacyApplicabilityInput {
  readonly authority?: PrivacyApplicabilityAuthority;
  readonly authorityEvidenceRefs?: readonly string[];
  readonly authorityReceiptRef?: string;
  readonly evaluatedAt: PrivacyApplicabilityDecision['evaluatedAt'];
  readonly policies: readonly PrivacyApplicabilityPolicy[];
  readonly proposedActivity: boolean;
  readonly responsibilityAssignmentRefs?: readonly PrivacyResponsibilityAssignmentRef[];
  readonly scope: PrivacyApplicabilityScope;
}

interface MaterializedApplicabilityAuthorityFields {
  authority: PrivacyApplicabilityAuthority;
  authorityEvidenceRefs?: string[];
  authorityReceiptRef?: string;
}

const scopeKey = (scope: PrivacyApplicabilityScope): string =>
  `${scope.processingScopeRef.scopeType}:${scope.processingScopeRef.scopeId}:${scope.operation}`;

const epochMillis = (value: string): number | undefined =>
  DateTime.make(value).pipe(Option.map(DateTime.toEpochMillis), Option.getOrUndefined);

const inEffectivePeriod = (policy: PrivacyApplicabilityPolicy, evaluatedAt: string): boolean => {
  const evaluatedAtMillis = epochMillis(evaluatedAt);
  const effectiveFromMillis = epochMillis(policy.effectiveFrom);
  const effectiveToMillis = policy.effectiveTo === null ? undefined : epochMillis(policy.effectiveTo);
  return (
    evaluatedAtMillis !== undefined &&
    effectiveFromMillis !== undefined &&
    evaluatedAtMillis >= effectiveFromMillis &&
    (policy.effectiveTo === null || (effectiveToMillis !== undefined && evaluatedAtMillis < effectiveToMillis))
  );
};

const factValuesByDimension = (scope: PrivacyApplicabilityScope): Map<PrivacyApplicabilityDimension, string[]> => {
  const values = new Map<PrivacyApplicabilityDimension, string[]>();
  for (const fact of scope.facts) {
    values.set(fact.dimension, [...(values.get(fact.dimension) ?? []), fact.value]);
  }
  return values;
};

const authoritativeFactValues = (
  authority: PrivacyApplicabilityAuthority | undefined,
): ReadonlyMap<PrivacyApplicabilityDimension, string> =>
  authority === undefined
    ? new Map()
    : new Map([
        ['CONTROLLER_SCOPE', authority.controllerRef.resourceId],
        ['PROCESSING_PURPOSE', authority.purposeRef.resourceId],
        ['PROCESSING_PURPOSE_VERSION', authority.purposeVersionRef.resourceId],
        ['TENANT', authority.tenantId],
      ]);

const predicateMatches = (predicate: PrivacyApplicabilityFactPredicate, value: string): boolean =>
  predicate.operator === 'EQUALS'
    ? predicate.values.length === 1 && predicate.values[0] === value
    : predicate.values.includes(value);

const decision = (
  input: ResolvePrivacyApplicabilityInput,
  outcome: PrivacyApplicabilityDecision['outcome'],
  reasonCodes: readonly string[],
  policies: readonly PrivacyApplicabilityPolicy[],
): PrivacyApplicabilityDecision => {
  const resolved: PrivacyApplicabilityDecision = {
    evaluatedAt: input.evaluatedAt,
    evaluatedScope: input.scope,
    evidenceRefs: policies.flatMap(({ sourceEvidenceRefs }) => sourceEvidenceRefs),
    outcome,
    policyIdentities: policies.map(({ jurisdictionProfile, policyKey, policyVersion }) => ({
      jurisdictionProfile,
      policyKey,
      policyVersion,
    })),
    proposedActivity: input.proposedActivity,
    reasonCodes,
    responsibilityAssignmentRefs: [...(input.responsibilityAssignmentRefs ?? [])],
  };
  if (input.authority === undefined) {
    return resolved;
  }
  const authoritativeFields: MaterializedApplicabilityAuthorityFields = { authority: input.authority };
  if (input.authorityEvidenceRefs !== undefined) {
    authoritativeFields.authorityEvidenceRefs = [...input.authorityEvidenceRefs];
  }
  if (input.authorityReceiptRef !== undefined) {
    authoritativeFields.authorityReceiptRef = input.authorityReceiptRef;
  }
  return { ...resolved, ...authoritativeFields };
};

type ApplicabilityPolicySelection =
  | {
      readonly outcome: 'READY';
      readonly policies: readonly PrivacyApplicabilityPolicy[];
      readonly policy: PrivacyApplicabilityPolicy;
    }
  | {
      readonly outcome: 'UNRESOLVED' | 'CONFLICT';
      readonly policies: readonly PrivacyApplicabilityPolicy[];
      readonly reasonCodes: readonly string[];
    };

const selectApplicabilityPolicy = (input: ResolvePrivacyApplicabilityInput): ApplicabilityPolicySelection => {
  const matching = input.policies.filter((policy) => policy.scopeKey === scopeKey(input.scope));
  if (matching.length === 0) {
    return { outcome: 'UNRESOLVED', policies: [], reasonCodes: ['policy_missing'] };
  }
  const effective = matching.filter((policy) => inEffectivePeriod(policy, input.evaluatedAt));
  if (effective.length === 0) {
    return { outcome: 'UNRESOLVED', policies: [], reasonCodes: ['policy_not_effective'] };
  }
  const highestPrecedence = Math.max(...effective.map(({ composition }) => composition.precedence));
  const selected = effective.filter(({ composition }) => composition.precedence === highestPrecedence);
  const [policy] = selected;
  return selected.length === 1 && policy !== undefined
    ? { outcome: 'READY', policies: selected, policy }
    : { outcome: 'CONFLICT', policies: selected, reasonCodes: ['policy_composition_conflict'] };
};

/** Resolves only explicit policy/fact matches. It never supplies Controller or jurisdiction from ambient context. */
export const resolvePrivacyApplicability = (input: ResolvePrivacyApplicabilityInput): PrivacyApplicabilityDecision => {
  if (input.authority === undefined) {
    return decision(input, 'UNRESOLVED', ['authority_missing'], []);
  }

  // Explicit precedence is not an implicit fallback: a lower layer cannot
  // approve the operation when the selected layer does not match its facts.
  const selection = selectApplicabilityPolicy(input);
  if (selection.outcome !== 'READY') {
    return decision(input, selection.outcome, selection.reasonCodes, selection.policies);
  }
  const { policies, policy } = selection;
  const dimensions = factValuesByDimension(input.scope);
  for (const [dimension, value] of authoritativeFactValues(input.authority)) {
    dimensions.set(dimension, [...(dimensions.get(dimension) ?? []), value]);
  }
  const conflictingDimensions = [...dimensions.entries()].filter(([, values]) => new Set(values).size > 1);
  if (conflictingDimensions.length > 0) {
    return decision(input, 'CONFLICT', ['declared_fact_conflict'], policies);
  }
  const missing = policy.mandatoryDimensions.filter((dimension) => !dimensions.has(dimension));
  if (missing.length > 0) {
    return decision(input, 'UNRESOLVED', ['mandatory_input_missing'], policies);
  }

  const predicateDimensions = new Set(policy.factPredicates.map(({ dimension }) => dimension));
  const missingPredicates = policy.mandatoryDimensions.filter((dimension) => !predicateDimensions.has(dimension));
  if (missingPredicates.length > 0) {
    return decision(input, 'UNRESOLVED', ['policy_predicate_missing'], policies);
  }

  const unmatched = policy.factPredicates.some((predicate) => {
    const values = dimensions.get(predicate.dimension);
    return values === undefined || values.some((value) => !predicateMatches(predicate, value));
  });
  if (unmatched) {
    return decision(input, 'UNRESOLVED', ['policy_predicate_mismatch'], policies);
  }

  return decision(input, 'APPLICABLE', ['explicit_policy_match'], policies);
};

const applicabilityDecisionEquivalent = Schema.toEquivalence(PrivacyApplicabilityDecisionSchema);
const applicabilityScopeEquivalent = Schema.toEquivalence(PrivacyApplicabilityScopeSchema);

/**
 * Resolves the one stored applicability decision that may authorize a later
 * operation. Callers may identify the scope and as-of time, but may not submit
 * an APPLICABLE decision as authority. A same-time or non-applicable latest
 * decision fails closed.
 */
export const resolveCurrentPrivacyApplicability = (
  decisions: readonly PrivacyApplicabilityDecision[],
  scope: PrivacyApplicabilityScope,
  asOf: string,
): PrivacyApplicabilityResolution => {
  const matching = decisions.filter(
    (candidate) => candidate.evaluatedAt <= asOf && applicabilityScopeEquivalent(candidate.evaluatedScope, scope),
  );
  const latestEvaluatedAt = matching
    .toSorted((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt))
    .at(-1)?.evaluatedAt;
  if (latestEvaluatedAt === undefined) {
    return { outcome: 'ABSENT' };
  }
  const latest = matching.filter(({ evaluatedAt }) => evaluatedAt === latestEvaluatedAt);
  if (latest.length !== 1) {
    return { decisions: latest, outcome: 'CONFLICT' };
  }
  const [selected] = latest;
  if (selected === undefined || selected.outcome !== 'APPLICABLE') {
    return { outcome: 'ABSENT' };
  }
  return { decision: selected, outcome: 'CURRENT' };
};

/** Same resolver for consumers whose payload identifies the operation/scope but not the fact list. */
export const resolveCurrentPrivacyApplicabilityForProcessingScope = (
  decisions: readonly PrivacyApplicabilityDecision[],
  operation: string,
  processingScopeRef: ProcessingScopeRef,
  asOf: string,
): PrivacyApplicabilityResolution => {
  const scopeCandidates = decisions.filter(
    (candidate) =>
      candidate.evaluatedAt <= asOf &&
      candidate.evaluatedScope.operation === operation &&
      candidate.evaluatedScope.processingScopeRef.scopeId === processingScopeRef.scopeId &&
      candidate.evaluatedScope.processingScopeRef.scopeType === processingScopeRef.scopeType,
  );
  const latestEvaluatedAt = scopeCandidates
    .toSorted((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt))
    .at(-1)?.evaluatedAt;
  if (latestEvaluatedAt === undefined) {
    return { outcome: 'ABSENT' };
  }
  const latest = scopeCandidates.filter(({ evaluatedAt }) => evaluatedAt === latestEvaluatedAt);
  if (latest.length !== 1) {
    return { decisions: latest, outcome: 'CONFLICT' };
  }
  const [selected] = latest;
  return selected?.outcome === 'APPLICABLE' ? { decision: selected, outcome: 'CURRENT' } : { outcome: 'ABSENT' };
};

const privacyApplicabilityAuthorityIdentityKey = (candidate: PrivacyApplicabilityDecision): string => {
  const { authority } = candidate;
  if (authority === undefined) {
    return '';
  }
  const { controllerRef, legalEntityId, purposeRef, purposeVersionRef, tenantId } = authority;
  const facts = candidate.evaluatedScope.facts
    .map(({ dimension, value }) => `${dimension}:${value}`)
    .toSorted()
    .join('\u0001');
  return [
    tenantId,
    legalEntityId,
    controllerRef.tenantId,
    controllerRef.moduleId,
    controllerRef.resourceType,
    controllerRef.resourceId,
    purposeRef.tenantId,
    purposeRef.moduleId,
    purposeRef.resourceType,
    purposeRef.resourceId,
    purposeVersionRef.tenantId,
    purposeVersionRef.moduleId,
    purposeVersionRef.resourceType,
    purposeVersionRef.resourceId,
    candidate.evaluatedScope.operation,
    candidate.evaluatedScope.processingScopeRef.scopeType,
    candidate.evaluatedScope.processingScopeRef.scopeId,
    facts,
  ].join('\u0000');
};

/**
 * Returns the latest decision for every exact authority identity in a
 * processing scope.  Outcome filtering deliberately happens after this
 * selection: a later UNRESOLVED or CONFLICT decision supersedes an older
 * APPLICABLE decision and therefore cannot authorize a new effect.
 */
export const latestPrivacyApplicabilityDecisionsForExactAuthorities = (
  decisions: readonly PrivacyApplicabilityDecision[],
  scope: PrivacyApplicabilityScope,
  asOf: string,
): readonly PrivacyApplicabilityDecision[] => {
  const candidates = decisions.filter(
    (candidate) =>
      candidate.authority !== undefined &&
      candidate.evaluatedAt <= asOf &&
      applicabilityScopeEquivalent(candidate.evaluatedScope, scope),
  );
  const latestByIdentity = new Map<string, string>();
  for (const candidate of candidates) {
    const key = privacyApplicabilityAuthorityIdentityKey(candidate);
    const latest = latestByIdentity.get(key);
    if (latest === undefined || candidate.evaluatedAt > latest) {
      latestByIdentity.set(key, candidate.evaluatedAt);
    }
  }
  return candidates.filter(
    (candidate) => candidate.evaluatedAt === latestByIdentity.get(privacyApplicabilityAuthorityIdentityKey(candidate)),
  );
};

export const privacyApplicabilityDecisionsAreEquivalent = applicabilityDecisionEquivalent;
