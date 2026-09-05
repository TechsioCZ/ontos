// Canonical schema-only contract extracted from the generated end-party-official-identifier Action.
import { Schema } from 'effect';
import { IsoTimestampSchema } from '../domain/identity-contracts.ts';
import { PartyOfficialIdentifierRefSchema } from '../resources/party-official-identifier.ts';
import { PartyRefSchema } from '../resources/party.ts';

export const EndPartyOfficialIdentifierPayloadSchema = Schema.Struct({
  officialIdentifierRef: PartyOfficialIdentifierRefSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  validTo: IsoTimestampSchema,
});
export type EndPartyOfficialIdentifierPayload = typeof EndPartyOfficialIdentifierPayloadSchema.Type;
export const EndPartyOfficialIdentifierResultSchema = Schema.Struct({
  officialIdentifierRef: PartyOfficialIdentifierRefSchema,
  partyRef: PartyRefSchema,
});
export type EndPartyOfficialIdentifierResult = typeof EndPartyOfficialIdentifierResultSchema.Type;
