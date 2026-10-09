/* oxlint-disable unicorn/prefer-export-from -- Codesmith Action HTTP requires concrete local schema export declarations. */
import {
  PhysicalStockEffectErrorSchema,
  PhysicalStockEffectPayloadSchema,
  RequestPhysicalStockEffectResultSchema,
} from '../domain/physical-stock-effect.ts';

export const StockIssueErrorSchema = PhysicalStockEffectErrorSchema;
export const StockIssuePayloadSchema = PhysicalStockEffectPayloadSchema;
export const StockIssueResultSchema = RequestPhysicalStockEffectResultSchema;
export type { PhysicalStockEffectPayload as StockIssuePayload } from '../domain/physical-stock-effect.ts';
/* oxlint-enable unicorn/prefer-export-from */
