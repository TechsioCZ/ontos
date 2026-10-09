import { Schema } from 'effect';

import { StockCorrectionIdSchema } from './stock-correction-identifiers.ts';

export class StockCorrectionRejected extends Schema.TaggedError<StockCorrectionRejected>()('StockCorrectionRejected', {
  code: Schema.Literal('stock_correction_rejected'),
  correctionId: StockCorrectionIdSchema,
  reason: Schema.Literals([
    'AUTHORITY_NOT_SELECTED',
    'CORRECTION_NOT_PERMITTED',
    'CUSTOMER_CONFIGURATION_MISMATCH',
    'POSITION_NOT_CURRENT',
    'POSITION_NOT_FOUND',
    'SOURCE_ASSERTION_NOT_FOUND',
    'SOURCE_ASSERTION_NOT_CURRENT',
    'SOURCE_ASSERTION_SCOPE_MISMATCH',
    'SOURCE_EVIDENCE_NOT_FOUND',
    'TENANT_SCOPE_MISMATCH',
    'UNIT_MISMATCH',
  ]),
}) {}
