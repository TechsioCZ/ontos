import { Schema } from 'effect';
import {
  AssortmentCatalogSelectorSchema,
  AssortmentCommercialScopeSchema,
  AssortmentDecisionEvidenceSchema,
  AssortmentDecisionOutcomeSchema,
  AssortmentDecisionPurposeSchema,
  AssortmentDecisionRequestSchema,
  AssortmentEffectSchema,
  AssortmentPurchasingSubjectSchema,
  AssortmentRuleRevisionReferenceSchema,
  AssortmentOwnerResourceRefSchema,
} from './decision-contracts.ts';
import { AssortmentConsumerDecisionEvidenceReferenceSchema } from './consumer-evidence.ts';
import { ApplicabilityBindingRefSchema } from '../resources/applicability-binding.ts';
import { ClosedAssortmentBoundaryRefSchema } from '../resources/closed-assortment-boundary.ts';
import { RuleRevisionRefSchema } from '../resources/rule-revision.ts';
import { StableRuleRefSchema } from '../resources/stable-rule.ts';

const InstantSchema = Schema.DateTimeUtcFromString;
const NonEmptyTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const MeaningFingerprintSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const BindingAudienceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('SHARED') }),
  Schema.Struct({ groupRef: AssortmentOwnerResourceRefSchema, kind: Schema.Literal('COMMERCE_CUSTOMER_GROUP') }),
  Schema.Struct({ kind: Schema.Literal('SUBJECT'), subject: AssortmentPurchasingSubjectSchema }),
]);

export const AssortmentConfigurationRequestSchema = Schema.Struct({
  resource: Schema.Union([
    StableRuleRefSchema,
    RuleRevisionRefSchema,
    ApplicabilityBindingRefSchema,
    ClosedAssortmentBoundaryRefSchema,
  ]),
});
export type AssortmentConfigurationRequest = typeof AssortmentConfigurationRequestSchema.Type;

export const AssortmentConfigurationRuleSchema = Schema.Struct({
  createdAt: InstantSchema,
  retiredAt: Schema.optionalKey(InstantSchema),
  stableCode: NonEmptyTextSchema,
  stableRuleRef: StableRuleRefSchema,
});

export const AssortmentConfigurationRevisionSchema = Schema.Struct({
  createdAt: InstantSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  effect: AssortmentEffectSchema,
  meaningFingerprint: MeaningFingerprintSchema,
  revision: AssortmentRuleRevisionReferenceSchema,
  selector: AssortmentCatalogSelectorSchema,
});

export const AssortmentConfigurationBindingSchema = Schema.Struct({
  audience: BindingAudienceSchema,
  bindingRef: ApplicabilityBindingRefSchema,
  commercialScope: AssortmentCommercialScopeSchema,
  effectiveFrom: InstantSchema,
  effectiveTo: Schema.optionalKey(InstantSchema),
  ruleRevision: AssortmentRuleRevisionReferenceSchema,
});

export const AssortmentConfigurationBoundarySchema = Schema.Struct({
  boundaryRef: ClosedAssortmentBoundaryRefSchema,
  commercialScope: AssortmentCommercialScopeSchema,
  decisionPurpose: AssortmentDecisionPurposeSchema,
  effectiveFrom: InstantSchema,
  effectiveTo: Schema.optionalKey(InstantSchema),
  meaningFingerprint: MeaningFingerprintSchema,
  subject: AssortmentPurchasingSubjectSchema,
});

export const AssortmentConfigurationResponseSchema = Schema.Struct({
  configuration: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('BOUNDARY'), value: AssortmentConfigurationBoundarySchema }),
    Schema.Struct({ kind: Schema.Literal('BINDING'), value: AssortmentConfigurationBindingSchema }),
    Schema.Struct({ kind: Schema.Literal('REVISION'), value: AssortmentConfigurationRevisionSchema }),
    Schema.Struct({ kind: Schema.Literal('RULE'), value: AssortmentConfigurationRuleSchema }),
  ]),
});
export type AssortmentConfigurationResponse = typeof AssortmentConfigurationResponseSchema.Type;

/** Protected explanation input: the supplied evidence must belong to this exact request. */
export const AssortmentDecisionExplanationRequestSchema = Schema.Struct({
  evidenceRef: AssortmentConsumerDecisionEvidenceReferenceSchema,
  request: AssortmentDecisionRequestSchema,
});
export type AssortmentDecisionExplanationRequest = typeof AssortmentDecisionExplanationRequestSchema.Type;

/** Explanation detail is deliberately protected; the public decision response remains redacted. */
export const AssortmentDecisionExplanationResponseSchema = Schema.Struct({
  evidence: AssortmentDecisionEvidenceSchema,
  outcome: AssortmentDecisionOutcomeSchema,
  requestFingerprint: MeaningFingerprintSchema,
});
export type AssortmentDecisionExplanationResponse = typeof AssortmentDecisionExplanationResponseSchema.Type;
