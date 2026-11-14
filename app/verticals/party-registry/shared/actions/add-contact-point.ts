// Canonical schema-only contract extracted from the generated add-contact-point Action.
import { Schema } from 'effect';

import { PartyClientSourceReferenceSchema } from '../domain/identity-contracts.ts';

import {
  ContactPointInputSchema,
  ContactPointPrivacyClassificationSchema,
  ContactPointProvenanceSchema,
  ContactPointTimestampSchema,
  PartyContactPointSchema,
} from '../domain/contact-point.ts';
import { PartyRefSchema } from '../resources/party.ts';

export const AddContactPointPayloadSchema = Schema.Struct({
  sourceReference: Schema.optionalKey(PartyClientSourceReferenceSchema),
  contactPoint: ContactPointInputSchema,
  partyRef: PartyRefSchema,
  privacyClassification: ContactPointPrivacyClassificationSchema,
  provenance: ContactPointProvenanceSchema,
  validFrom: ContactPointTimestampSchema,
});
export type AddContactPointPayload = typeof AddContactPointPayloadSchema.Type;

export const AddContactPointResultSchema = PartyContactPointSchema;
export type AddContactPointResult = typeof AddContactPointResultSchema.Type;
