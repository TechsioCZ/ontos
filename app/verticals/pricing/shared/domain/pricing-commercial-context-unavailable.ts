import { Schema } from 'effect';

export class PricingCommercialContextUnavailable extends Schema.TaggedError<PricingCommercialContextUnavailable>()(
  'PricingCommercialContextUnavailable',
  {
    code: Schema.Literal('pricing_commercial_context_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
