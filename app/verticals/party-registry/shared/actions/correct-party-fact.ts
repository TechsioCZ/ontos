// Canonical schema-only contract extracted from the generated correct-party-fact Action.
import { PartyCorrectionCommandSchema } from '../domain/correction-contracts.ts';

export const CorrectPartyFactPayloadSchema = PartyCorrectionCommandSchema;
export type CorrectPartyFactPayload = typeof CorrectPartyFactPayloadSchema.Type;
export { PartyCorrectionResultSchema as CorrectPartyFactResultSchema } from '../domain/correction-contracts.ts';
