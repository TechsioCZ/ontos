import { Schema } from 'effect';

import { ExternalStockLocationKeySchema } from '../../shared/domain/stock-location.ts';

export class StockLocationCorrelationUnresolved extends Schema.TaggedError<StockLocationCorrelationUnresolved>()(
  'StockLocationCorrelationUnresolved',
  {
    reason: Schema.Literals([
      'AMBIGUOUS_EXPLICIT_CORRELATION',
      'CORRELATION_READER_UNAVAILABLE',
      'INVALID_EXPLICIT_CORRELATION',
      'NO_EXPLICIT_CORRELATION',
    ]),
    source: ExternalStockLocationKeySchema,
  },
) {}
