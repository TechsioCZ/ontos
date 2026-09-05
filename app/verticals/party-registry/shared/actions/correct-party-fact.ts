// Canonical schema-only contract extracted from the generated correct-party-fact Action.
import {
  PartyCorrectionCommandSchema,
  PartyCorrectionResultSchema,
} from '../domain/correction-contracts.ts';

export const CorrectPartyFactPayloadSchema = PartyCorrectionCommandSchema;
export type CorrectPartyFactPayload = typeof CorrectPartyFactPayloadSchema.Type;
export const CorrectPartyFactResultSchema = PartyCorrectionResultSchema;
export type CorrectPartyFactResult = typeof CorrectPartyFactResultSchema.Type;
