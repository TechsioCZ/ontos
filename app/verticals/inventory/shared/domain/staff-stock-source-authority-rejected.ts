import { Schema } from 'effect';

export class StaffStockSourceAuthorityRejected extends Schema.TaggedError<StaffStockSourceAuthorityRejected>()(
  'StaffStockSourceAuthorityRejected',
  {
    code: Schema.Literal('staff_stock_source_authority_rejected'),
    reason: Schema.String,
  },
) {}
