// Canonical schema-only contract for the repeat-counterparty-order Action.
import {
  RepeatCounterpartyOrderPayloadSchema as HistoryRepeatCounterpartyOrderPayloadSchema,
  RepeatOrderActionResultSchema,
} from '../domain/history-action-contracts.ts';

export const RepeatCounterpartyOrderPayloadSchema = HistoryRepeatCounterpartyOrderPayloadSchema;
export type RepeatCounterpartyOrderPayload = typeof RepeatCounterpartyOrderPayloadSchema.Type;

export const RepeatCounterpartyOrderResultSchema = RepeatOrderActionResultSchema;
// eslint-disable-next-line no-unused-vars -- Preserve the generated named result contract for this schema alias.
type RepeatCounterpartyOrderResult = typeof RepeatCounterpartyOrderResultSchema.Type;
