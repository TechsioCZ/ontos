// Canonical schema-only contract extracted from the generated add-contact-point Action.
import { Schema } from 'effect';
import {
  ContactPointInputSchema,
  ContactPointPrivacyClassificationSchema,
  ContactPointProvenanceSchema,
  ContactPointTimestampSchema,
  ContactPointVerificationSchema,
  PartyContactPointSchema,
} from '../domain/contact-point.ts';
import { PartyRefSchema } from '../resources/party.ts';

export const AddContactPointPayloadSchema = Schema.Struct({
  contactPoint: ContactPointInputSchema,
  partyRef: PartyRefSchema,
  privacyClassification: ContactPointPrivacyClassificationSchema,
  provenance: ContactPointProvenanceSchema,
  validFrom: ContactPointTimestampSchema,
  verification: ContactPointVerificationSchema,
});
export type AddContactPointPayload = typeof AddContactPointPayloadSchema.Type;

export const AddContactPointResultSchema = PartyContactPointSchema;
export type AddContactPointResult = typeof AddContactPointResultSchema.Type;
