import { Schema } from 'effect';

export class PricingPromotionUnverifiable extends Schema.TaggedError<PricingPromotionUnverifiable>()(
  'PricingPromotionUnverifiable',
  { reason: Schema.String, retryable: Schema.Literal(true) },
) {}
