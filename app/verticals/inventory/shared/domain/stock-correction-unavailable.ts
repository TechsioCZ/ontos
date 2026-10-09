import { Schema } from 'effect';

import { StockCorrectionIdSchema } from './stock-correction-identifiers.ts';

export class StockCorrectionUnavailable extends Schema.TaggedError<StockCorrectionUnavailable>()(
  'StockCorrectionUnavailable',
  {
    code: Schema.Literal('stock_correction_unavailable'),
    correctionId: Schema.optionalKey(StockCorrectionIdSchema),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
