import { Schema } from 'effect';

export class PricingPromotionInputInvalid extends Schema.TaggedError<PricingPromotionInputInvalid>()(
  'PricingPromotionInputInvalid',
  { reason: Schema.String },
) {}
