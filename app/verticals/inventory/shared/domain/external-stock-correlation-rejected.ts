import { Schema } from 'effect';

import { ExternalStockCorrelationRefSchema } from '../resources/external-stock-correlation.ts';

export class ExternalStockCorrelationRejected extends Schema.TaggedError<ExternalStockCorrelationRejected>()(
  'ExternalStockCorrelationRejected',
  {
    code: Schema.Literal('external_stock_correlation_rejected'),
    correlationRef: Schema.optionalKey(ExternalStockCorrelationRefSchema),
    reason: Schema.Literals([
      'AMBIGUOUS_EFFECTIVE_CORRELATION',
      'CORRELATION_IDENTITY_CONFLICT',
      'CORRELATION_NOT_CURRENT',
      'CORRELATION_NOT_FOUND',
      'CORRELATION_REVISION_CONFLICT',
      'INVALID_CORRELATION',
      'OVERLAPPING_EFFECTIVE_PERIOD',
      'TARGET_NOT_FOUND',
      'TARGET_UNCHANGED',
      'TENANT_SCOPE_MISMATCH',
    ]),
  },
) {}
