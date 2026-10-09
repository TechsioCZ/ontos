import { Schema } from 'effect';

export class StockItemPersistenceUnavailable extends Schema.TaggedError<StockItemPersistenceUnavailable>()(
  'StockItemPersistenceUnavailable',
  {
    code: Schema.Literal('stock_item_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
