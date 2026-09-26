import { Schema } from 'effect';

export class ExternalStockCorrelationPersistenceUnavailable extends Schema.TaggedError<ExternalStockCorrelationPersistenceUnavailable>()(
  'ExternalStockCorrelationPersistenceUnavailable',
  {
    code: Schema.Literal('external_stock_correlation_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
