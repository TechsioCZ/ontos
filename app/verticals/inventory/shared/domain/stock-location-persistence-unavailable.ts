import { Schema } from 'effect';

export class StockLocationPersistenceUnavailable extends Schema.TaggedError<StockLocationPersistenceUnavailable>()(
  'StockLocationPersistenceUnavailable',
  {
    code: Schema.Literal('stock_location_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
