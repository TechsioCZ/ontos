/* oxlint-disable unicorn/prefer-export-from -- Codesmith Action HTTP requires concrete local schema export declarations. */
import {
  StockCorrectionErrorSchema,
  StockCorrectionPayloadSchema,
  StockCorrectionResultSchema,
} from '../domain/stock-correction.ts';

export const CorrectStockPositionErrorSchema = StockCorrectionErrorSchema;
export const CorrectStockPositionPayloadSchema = StockCorrectionPayloadSchema;
export const CorrectStockPositionResultSchema = StockCorrectionResultSchema;
export type { StockCorrectionPayload as CorrectStockPositionPayload } from '../domain/stock-correction.ts';
/* oxlint-enable unicorn/prefer-export-from */
