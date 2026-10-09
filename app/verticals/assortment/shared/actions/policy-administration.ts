import { DateTime, Schema } from 'effect';
import {
  AssortmentCommercialScopeSchema,
  AssortmentEffectSchema,
  AssortmentRuleRevisionReferenceSchema,
  AssortmentStableRuleRefSchema,
  AssortmentApplicabilityBindingRefSchema,
  AssortmentCatalogSelectorSchema,
  AssortmentDecisionPurposeSchema,
  AssortmentPurchasingSubjectSchema,
  AssortmentOwnerResourceRefSchema,
} from '../domain/decision-contracts.ts';

const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ProvenanceRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const InstantSchema = Schema.DateTimeUtcFromString;
const FingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const RevisionNumberSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const AssortmentBindingAudienceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('SHARED') }),
  Schema.Struct({
    groupRef: AssortmentOwnerResourceRefSchema.check(
      Schema.makeFilter((ref) =>
        ref.moduleId === 'commerce.customer-context' && ref.resourceType === 'commerce.customer-context.customer-group'
          ? undefined
          : 'Binding Customer Group references must identify Commerce Customer Context groups',
      ),
    ),
    kind: Schema.Literal('COMMERCE_CUSTOMER_GROUP'),
  }),
  Schema.Struct({ kind: Schema.Literal('SUBJECT'), subject: AssortmentPurchasingSubjectSchema }),
]);
export type AssortmentBindingAudience = typeof AssortmentBindingAudienceSchema.Type;

export const CreateRulePayloadSchema = Schema.Struct({
  effect: AssortmentEffectSchema,
  provenanceRef: ProvenanceRefSchema,
  purpose: AssortmentDecisionPurposeSchema,
  reason: ReasonSchema,
  selector: AssortmentCatalogSelectorSchema,
  stableCode: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9._-]{0,127}$/u)),
});
export type CreateRulePayload = typeof CreateRulePayloadSchema.Type;
export const CreateRuleResultSchema = Schema.Struct({
  created: Schema.Boolean,
  initialRuleRevisionRef: AssortmentRuleRevisionReferenceSchema,
  stableRuleRef: AssortmentStableRuleRefSchema,
});

export const CreateRuleRevisionPayloadSchema = Schema.Struct({
  effect: AssortmentEffectSchema,
  expectedLatestRevision: RevisionNumberSchema,
  provenanceRef: ProvenanceRefSchema,
  purpose: AssortmentDecisionPurposeSchema,
  reason: ReasonSchema,
  selector: AssortmentCatalogSelectorSchema,
  stableRuleRef: AssortmentStableRuleRefSchema,
});
export type CreateRuleRevisionPayload = typeof CreateRuleRevisionPayloadSchema.Type;
export const CreateRuleRevisionResultSchema = Schema.Struct({
  created: Schema.Boolean,
  revisionNumber: RevisionNumberSchema,
  ruleRevisionRef: AssortmentRuleRevisionReferenceSchema,
});

export const RetireRulePayloadSchema = Schema.Struct({
  effectiveAt: InstantSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  stableRuleRef: AssortmentStableRuleRefSchema,
});
export type RetireRulePayload = typeof RetireRulePayloadSchema.Type;
export const RetireRuleResultSchema = Schema.Struct({
  retired: Schema.Boolean,
  stableRuleRef: AssortmentStableRuleRefSchema,
});

export const CreateApplicabilityBindingPayloadSchema = Schema.Struct({
  audience: AssortmentBindingAudienceSchema,
  commercialScope: AssortmentCommercialScopeSchema,
  effectiveFrom: InstantSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
  ruleRevisionRef: AssortmentRuleRevisionReferenceSchema,
});
export type CreateApplicabilityBindingPayload = typeof CreateApplicabilityBindingPayloadSchema.Type;
export const CreateApplicabilityBindingResultSchema = Schema.Struct({
  applicabilityBindingRef: AssortmentApplicabilityBindingRefSchema,
  created: Schema.Boolean,
});

export const EndApplicabilityBindingPayloadSchema = Schema.Struct({
  applicabilityBindingRef: AssortmentApplicabilityBindingRefSchema,
  effectiveAt: InstantSchema,
  expectedBasisFingerprint: FingerprintSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
});
export type EndApplicabilityBindingPayload = typeof EndApplicabilityBindingPayloadSchema.Type;
export const EndApplicabilityBindingResultSchema = Schema.Struct({
  applicabilityBindingRef: AssortmentApplicabilityBindingRefSchema,
  ended: Schema.Boolean,
});

export const ReplaceApplicabilityBindingPayloadSchema = Schema.Struct({
  effectiveAt: InstantSchema,
  existingBindingRef: AssortmentApplicabilityBindingRefSchema,
  expectedExistingBasisFingerprint: FingerprintSchema,
  proposedAudience: AssortmentBindingAudienceSchema,
  proposedCommercialScope: AssortmentCommercialScopeSchema,
  proposedEffectiveFrom: InstantSchema,
  proposedRuleRevisionRef: AssortmentRuleRevisionReferenceSchema,
  provenanceRef: ProvenanceRefSchema,
  reason: ReasonSchema,
}).check(
  Schema.makeFilter((payload) =>
    DateTime.formatIso(payload.effectiveAt) === DateTime.formatIso(payload.proposedEffectiveFrom)
      ? undefined
      : 'A Binding replacement must end and create at one trusted effective time',
  ),
);
export type ReplaceApplicabilityBindingPayload = typeof ReplaceApplicabilityBindingPayloadSchema.Type;
export const ReplaceApplicabilityBindingResultSchema = Schema.Struct({
  createdBindingRef: AssortmentApplicabilityBindingRefSchema,
  endedBindingRef: AssortmentApplicabilityBindingRefSchema,
  replaced: Schema.Boolean,
});
