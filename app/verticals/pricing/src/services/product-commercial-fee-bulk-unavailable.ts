import { Schema } from 'effect';

export class ProductCommercialFeeBulkUnavailable extends Schema.TaggedError<ProductCommercialFeeBulkUnavailable>()(
  'ProductCommercialFeeBulkUnavailable',
  {
    code: Schema.Literal('product_commercial_fee_bulk_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
