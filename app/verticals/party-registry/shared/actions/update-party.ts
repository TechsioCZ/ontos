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
  businessName: Schema.optionalKey(PartyDisplayNameSchema),
  firstName: Schema.optionalKey(PartyDisplayNameSchema),
  lastName: Schema.optionalKey(PartyDisplayNameSchema),
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
    input.firstName === undefined &&
    input.lastName === undefined &&
    input.businessName === undefined &&
    input.partyType === undefined
      ? 'a name change or Party Type enrichment is required'
      : undefined,
  ),
);
export type UpdatePartyPayload = typeof UpdatePartyPayloadSchema.Type;
/** Governed company-only processing acknowledges refs and revision without a compatibility snapshot. */
export const OrganizationBusinessPartyUpdatedSchema = Schema.TaggedStruct('OrganizationBusinessPartyUpdated', {
  partyRef: PartyRefSchema,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const UpdatePartyResultSchema = Schema.Union([PartySchema, OrganizationBusinessPartyUpdatedSchema]);
export type UpdatePartyResult = typeof UpdatePartyResultSchema.Type;
