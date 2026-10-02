import { Schema } from 'effect';

export class PricingPromotionUnavailable extends Schema.TaggedError<PricingPromotionUnavailable>()(
  'PricingPromotionUnavailable',
  { reason: Schema.String, retryable: Schema.Literal(true) },
) {}
