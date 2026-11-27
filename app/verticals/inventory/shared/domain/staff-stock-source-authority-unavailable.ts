import { Schema } from 'effect';

export class StaffStockSourceAuthorityUnavailable extends Schema.TaggedError<StaffStockSourceAuthorityUnavailable>()(
  'StaffStockSourceAuthorityUnavailable',
  {
    code: Schema.Literal('staff_stock_source_authority_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
