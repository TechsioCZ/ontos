import { Schema } from 'effect';

export class StockSharingEligibilityUnavailable extends Schema.TaggedError<StockSharingEligibilityUnavailable>()(
  'StockSharingEligibilityUnavailable',
  {
    code: Schema.Literal('stock_sharing_eligibility_unavailable'),
    reason: Schema.Literal('Stock Sharing Eligibility persistence or owner validation is temporarily unavailable'),
  },
) {}
