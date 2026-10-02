import { Schema } from 'effect';

export class PricingPromotionParked extends Schema.TaggedError<PricingPromotionParked>()('PricingPromotionParked', {
  reason: Schema.Literal('NON_POSITIVE_ELIGIBLE_PRE_PROMOTION_BASIS_REQUIRES_OWNER_DECISION'),
}) {}
