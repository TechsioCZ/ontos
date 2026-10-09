import { Schema } from 'effect';

import { StockCorrectionIdSchema } from './stock-correction-identifiers.ts';

export class StockCorrectionConflict extends Schema.TaggedError<StockCorrectionConflict>()('StockCorrectionConflict', {
  code: Schema.Literal('stock_correction_conflict'),
  correctionId: StockCorrectionIdSchema,
  reason: Schema.Literals([
    'ASSERTION_ALREADY_USED',
    'EVIDENCE_ALREADY_USED',
    'CORRECTION_ID_CONFLICT',
    'OPEN_RECONCILIATION_MISMATCH',
    'POSITION_REVISION_CONFLICT',
  ]),
}) {}
