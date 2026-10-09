import { Schema } from 'effect';

export class PricingPromotionConflict extends Schema.TaggedError<PricingPromotionConflict>()(
  'PricingPromotionConflict',
  { reason: Schema.String },
) {}
