/* oxlint-disable unicorn/prefer-export-from -- Codesmith Action HTTP requires concrete local schema export declarations. */
import {
  PhysicalStockEffectErrorSchema,
  PhysicalStockEffectPayloadSchema,
  RequestPhysicalStockEffectResultSchema,
} from '../domain/physical-stock-effect.ts';

export const StockReceiptErrorSchema = PhysicalStockEffectErrorSchema;
export const StockReceiptPayloadSchema = PhysicalStockEffectPayloadSchema;
export const StockReceiptResultSchema = RequestPhysicalStockEffectResultSchema;
export type { PhysicalStockEffectPayload as StockReceiptPayload } from '../domain/physical-stock-effect.ts';
/* oxlint-enable unicorn/prefer-export-from */
