import { Schema } from 'effect';

export class StockPositionAllocationReadUnavailable extends Schema.TaggedError<StockPositionAllocationReadUnavailable>()(
  'StockPositionAllocationReadUnavailable',
  {
    code: Schema.Literal('stock_position_allocation_read_unavailable'),
    reason: Schema.String,
  },
) {}
