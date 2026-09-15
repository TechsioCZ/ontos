import { Schema } from 'effect';

import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import type { PrivacyResponsibilityAssignmentRef } from '../resources/privacy-responsibility-assignment.ts';
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
  'SITE',
  'TENANT',
]);
type PrivacyApplicabilityDimension = typeof PrivacyApplicabilityDimensionSchema.Type;

const PrivacyApplicabilityFactSchema = Schema.Struct({
  dimension: PrivacyApplicabilityDimensionSchema,
  value: Text,
});

/** The scope is deliberately a caller-declared, stable business scope, not an inferred request context. */
export const PrivacyApplicabilityScopeSchema = Schema.Struct({
  facts: Schema.Array(PrivacyApplicabilityFactSchema).check(Schema.isMaxLength(32)),
  operation: Text,
  processingScopeRef: ProcessingScopeRefSchema,
});
export type PrivacyApplicabilityScope = typeof PrivacyApplicabilityScopeSchema.Type;

export const PrivacyApplicabilityPolicySchema = Schema.Struct({
  composition: Schema.Struct({
    precedence: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    strategy: Schema.Literal('EXPLICIT_PRECEDENCE'),
  }),
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  jurisdictionProfile: Schema.Literal('EU_EEA_GDPR_BASELINE'),
  mandatoryDimensions: Schema.Array(PrivacyApplicabilityDimensionSchema).check(Schema.isMaxLength(16)),
  policyKey: PolicyKeySchema,
  policyVersion: Version,
  scopeKey: ScopeKeySchema,
  sourceEvidenceRefs: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type PrivacyApplicabilityPolicy = typeof PrivacyApplicabilityPolicySchema.Type;

export const PrivacyApplicabilityDecisionSchema = Schema.Struct({
  evaluatedAt: PrivacyIsoTimestampSchema,
  evaluatedScope: PrivacyApplicabilityScopeSchema,
  evidenceRefs: Schema.Array(Text).check(Schema.isMaxLength(32)),
  outcome: Schema.Literals(['APPLICABLE', 'UNRESOLVED', 'CONFLICT']),
  policyIdentities: Schema.Array(
    Schema.Struct({
      policyKey: PolicyKeySchema,
      policyVersion: Version,
    }),
  ).check(Schema.isMaxLength(16)),
  proposedActivity: Schema.Boolean,
  reasonCodes: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(Schema.isMaxLength(32)),
});
export type PrivacyApplicabilityDecision = typeof PrivacyApplicabilityDecisionSchema.Type;

export interface ResolvePrivacyApplicabilityInput {
  readonly evaluatedAt: PrivacyApplicabilityDecision['evaluatedAt'];
  readonly policies: readonly PrivacyApplicabilityPolicy[];
  readonly proposedActivity: boolean;
  readonly responsibilityAssignmentRefs?: readonly PrivacyResponsibilityAssignmentRef[];
  readonly scope: PrivacyApplicabilityScope;
}

const scopeKey = (scope: PrivacyApplicabilityScope): string =>
  `${scope.processingScopeRef.scopeType}:${scope.processingScopeRef.scopeId}:${scope.operation}`;

const decision = (
  input: ResolvePrivacyApplicabilityInput,
  outcome: PrivacyApplicabilityDecision['outcome'],
  reasonCodes: readonly string[],
  policies: readonly PrivacyApplicabilityPolicy[],
): PrivacyApplicabilityDecision => ({
  evaluatedAt: input.evaluatedAt,
  evaluatedScope: input.scope,
  evidenceRefs: policies.flatMap(({ sourceEvidenceRefs }) => sourceEvidenceRefs),
  outcome,
  policyIdentities: policies.map(({ policyKey, policyVersion }) => ({ policyKey, policyVersion })),
  proposedActivity: input.proposedActivity,
  reasonCodes,
  responsibilityAssignmentRefs: [...(input.responsibilityAssignmentRefs ?? [])],
});

/** Resolves only explicit policy/fact matches. It never supplies Controller or jurisdiction from ambient context. */
export const resolvePrivacyApplicability = (input: ResolvePrivacyApplicabilityInput): PrivacyApplicabilityDecision => {
  const matching = input.policies.filter((policy) => policy.scopeKey === scopeKey(input.scope));
  if (matching.length === 0) {
    return decision(input, 'UNRESOLVED', ['policy_missing'], []);
  }

  const highestPrecedence = Math.max(...matching.map(({ composition }) => composition.precedence));
  const selected = matching.filter(({ composition }) => composition.precedence === highestPrecedence);
  if (selected.length !== 1) {
    return decision(input, 'CONFLICT', ['policy_composition_conflict'], selected);
  }

  const [policy] = selected;
  if (policy === undefined) {
    return decision(input, 'CONFLICT', ['policy_composition_conflict'], selected);
  }
  const dimensions = new Map<PrivacyApplicabilityDimension, string[]>();
  for (const fact of input.scope.facts) {
    dimensions.set(fact.dimension, [...(dimensions.get(fact.dimension) ?? []), fact.value]);
  }
  const conflictingDimensions = [...dimensions.entries()].filter(([, values]) => new Set(values).size > 1);
  if (conflictingDimensions.length > 0) {
    return decision(input, 'CONFLICT', ['declared_fact_conflict'], selected);
  }
  const missing = policy.mandatoryDimensions.filter((dimension) => !dimensions.has(dimension));
  if (missing.length > 0) {
    return decision(input, 'UNRESOLVED', ['mandatory_input_missing'], selected);
  }
  return decision(input, 'APPLICABLE', ['explicit_policy_match'], selected);
};
