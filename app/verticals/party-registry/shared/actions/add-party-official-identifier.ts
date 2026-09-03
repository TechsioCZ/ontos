// Canonical schema-only contract extracted from the generated add-party-official-identifier Action.
import { Schema } from 'effect';
import { AresAppliedEvidenceSchema } from '../domain/ares-application.ts';
import { IsoTimestampSchema } from '../domain/identity-contracts.ts';
import { OfficialIdentifierInputSchema } from '../domain/identifier-contracts.ts';
import { PartyOfficialIdentifierRefSchema } from '../resources/party-official-identifier.ts';
import { PartyRefSchema } from '../resources/party.ts';

export const AddPartyOfficialIdentifierPayloadSchema = Schema.Struct({
  externalEvidence: Schema.optionalKey(AresAppliedEvidenceSchema),
  identifier: OfficialIdentifierInputSchema,
  partyRef: PartyRefSchema,
  provenanceMethod: Schema.String,
  provenanceSource: Schema.String,
  validFrom: IsoTimestampSchema,
});
export type AddPartyOfficialIdentifierPayload = typeof AddPartyOfficialIdentifierPayloadSchema.Type;
export const AddPartyOfficialIdentifierResultSchema = Schema.Struct({
  officialIdentifierRef: PartyOfficialIdentifierRefSchema,
  partyRef: PartyRefSchema,
});
export type AddPartyOfficialIdentifierResult = typeof AddPartyOfficialIdentifierResultSchema.Type;
