import { Schema } from 'effect';

import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import { ProcessingScopeRefSchema } from './processing-scope-ref.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const RefList = Schema.Array(Ref).check(Schema.isMaxLength(64));
export const PrivacyEligibilityDecisionOutcomeSchema = Schema.Literals(['ALLOWED', 'NOT_ALLOWED', 'INDETERMINATE']);

/** The complete business identity of the use being checked. Ambient request context is never added. */
export const IntendedProcessingScopeSchema = Schema.Struct({
  controllerRef: Ref,
  dataCategoryRefs: RefList,
  operation: Ref,
  processingScopeRef: ProcessingScopeRefSchema,
  purposeRef: Ref,
  purposeVersionId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyPurposeVersionId'))),
  recipientRefs: RefList,
  subjectRef: PrivacySubjectRefSchema,
});
export type IntendedProcessingScope = typeof IntendedProcessingScopeSchema.Type;

export const PrivacyInputStateSchema = Schema.Literals(['CURRENT', 'ABSENT', 'STALE', 'UNAVAILABLE', 'CONFLICT']);
export type PrivacyInputState = typeof PrivacyInputStateSchema.Type;

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
