// Canonical schema-only contract for the repeat-retail-order Action.
import {
  RepeatOrderActionResultSchema,
  RepeatRetailOrderPayloadSchema as HistoryRepeatRetailOrderPayloadSchema,
} from '../domain/history-action-contracts.ts';

export const RepeatRetailOrderPayloadSchema = HistoryRepeatRetailOrderPayloadSchema;
export type RepeatRetailOrderPayload = typeof RepeatRetailOrderPayloadSchema.Type;

export const RepeatRetailOrderResultSchema = RepeatOrderActionResultSchema;
// eslint-disable-next-line no-unused-vars -- Preserve the generated named result contract for this schema alias.
type RepeatRetailOrderResult = typeof RepeatRetailOrderResultSchema.Type;
