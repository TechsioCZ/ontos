// Canonical schema-only contract extracted from the generated update-party Action.
import { Schema } from 'effect';
import { AresAppliedEvidenceSchema } from '../domain/ares-application.ts';
import {
  IsoTimestampSchema,
  PartyDisplayNameSchema,
  PartySchema,
  PartyTypeSchema,
  PartySubjectEvidenceListSchema,
} from '../domain/identity-contracts.ts';
import { PartyRefSchema } from '../resources/party.ts';

export const UpdatePartyPayloadSchema = Schema.Struct({
  displayName: Schema.optionalKey(PartyDisplayNameSchema),
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  externalEvidence: Schema.optionalKey(AresAppliedEvidenceSchema),
  partyRef: PartyRefSchema,
  partyType: Schema.optionalKey(PartyTypeSchema),
  provenanceMethod: Schema.String,
  provenanceSource: Schema.String,
  subjectEvidence: Schema.optionalKey(PartySubjectEvidenceListSchema),
  validFrom: IsoTimestampSchema,
}).check(
  Schema.makeFilter((input) =>
    input.displayName === undefined && input.partyType === undefined
      ? 'a display-name change or Party Type enrichment is required'
      : undefined,
  ),
);
export type UpdatePartyPayload = typeof UpdatePartyPayloadSchema.Type;
export const UpdatePartyResultSchema = PartySchema;
export type UpdatePartyResult = typeof UpdatePartyResultSchema.Type;
