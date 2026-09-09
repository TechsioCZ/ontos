// Canonical schema-only contract for the repeat-retail-order Action.
import {
  RepeatOrderActionResultSchema,
  RepeatRetailOrderPayloadSchema as HistoryRepeatRetailOrderPayloadSchema,
} from '../domain/history-action-contracts.ts';

export const RepeatRetailOrderPayloadSchema = HistoryRepeatRetailOrderPayloadSchema;
export type RepeatRetailOrderPayload = typeof RepeatRetailOrderPayloadSchema.Type;

export const RepeatRetailOrderResultSchema = RepeatOrderActionResultSchema;
export type RepeatRetailOrderResult = typeof RepeatRetailOrderResultSchema.Type;
