import { PricingDecisionSubjectSchema } from '@app/pricing-contracts/current-pricing-decision';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PricingDecisionSchema, PricingPurchasingContextSchema } from '@app/pricing-contracts/pricing-decision';
import { Schema } from 'effect';

/** CCC-issued context for one durable approved request; callers cannot supply its owner facts. */
export const OrderFinalizationPricingContextSchema = Schema.Struct({
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingDecisionSchema.fields.currencyCode,
  purchasingContext: PricingPurchasingContextSchema,
  subject: PricingDecisionSubjectSchema,
});
