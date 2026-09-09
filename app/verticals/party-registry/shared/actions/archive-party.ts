// Canonical schema-only contract extracted from the generated archive-party Action.
import { Schema } from 'effect';

import { PartyRefSchema } from '../resources/party.ts';

export const ArchivePartyPayloadSchema = Schema.Struct({
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  partyRef: PartyRefSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type ArchivePartyPayload = typeof ArchivePartyPayloadSchema.Type;
export { PartySchema as ArchivePartyResultSchema } from '../domain/identity-contracts.ts';
