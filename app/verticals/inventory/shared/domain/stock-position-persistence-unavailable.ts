import { Schema } from 'effect';

export class StockPositionPersistenceUnavailable extends Schema.TaggedError<StockPositionPersistenceUnavailable>()(
  'StockPositionPersistenceUnavailable',
  {
    code: Schema.Literal('stock_position_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
