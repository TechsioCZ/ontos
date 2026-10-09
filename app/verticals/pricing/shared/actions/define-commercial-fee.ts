import {
  PricingCommercialFeeCatalogTargetEvidenceSchema,
  PricingCommercialFeeConfiguredAmountSchema,
  PricingCommercialFeeDefinitionSchema,
  PricingCommercialFeeEffectivePeriodSchema,
  PricingCommercialFeeIdentityKeySchema,
} from '@app/pricing-contracts/domain/commercial-fee';
import { Schema } from 'effect';

export const DefineCommercialFeeReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);

export const DefineCommercialFeePayloadSchema = Schema.Struct({
  catalogTargetEvidence: PricingCommercialFeeCatalogTargetEvidenceSchema,
  configuredAmount: PricingCommercialFeeConfiguredAmountSchema,
  effectivePeriod: PricingCommercialFeeEffectivePeriodSchema,
  identityKey: PricingCommercialFeeIdentityKeySchema,
  reason: DefineCommercialFeeReasonSchema,
});
export type DefineCommercialFeePayload = typeof DefineCommercialFeePayloadSchema.Type;

export const DefineCommercialFeeResultSchema = Schema.Struct({
  definition: PricingCommercialFeeDefinitionSchema,
  outcome: Schema.Literals(['COMMERCIAL_FEE_CREATED', 'COMMERCIAL_FEE_REUSED']),
});
export type DefineCommercialFeeResult = typeof DefineCommercialFeeResultSchema.Type;
