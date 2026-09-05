// Canonical schema-only contract extracted from the generated update-contact-point Action.
import { Schema } from 'effect';
import {
  AddressPurposeAssignmentSchema,
  AddressPurposeTargetSchema,
  ContactPointInputSchema,
  ContactPointPrivacyClassificationSchema,
  ContactPointProvenanceSchema,
  ContactPointTimestampSchema,
  ContactPointVerificationSchema,
  PartyContactPointSchema,
} from '../domain/contact-point.ts';
import { PartyContactPointRefSchema } from '../resources/party-contact-point.ts';

export const ContactPointMetadataChangeSchema = Schema.Union([
  Schema.Struct({ preferred: Schema.Boolean, type: Schema.Literal('SET_CHANNEL_PREFERRED') }),
  Schema.Struct({
    assignment: AddressPurposeAssignmentSchema,
    type: Schema.Literal('SET_ADDRESS_PURPOSE'),
  }),
  Schema.Struct({
    effectiveEnd: ContactPointTimestampSchema,
    reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    target: AddressPurposeTargetSchema,
    type: Schema.Literal('END_ADDRESS_PURPOSE'),
  }),
  Schema.Struct({
    type: Schema.Literal('ENRICH_VERIFICATION'),
    verification: ContactPointVerificationSchema,
  }),
  Schema.Struct({
    provenance: ContactPointProvenanceSchema,
    type: Schema.Literal('ADD_PROVENANCE'),
  }),
  Schema.Struct({
    evidenceReferences: Schema.Array(
      Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    replacement: Schema.optionalKey(
      Schema.Struct({
        contactPoint: ContactPointInputSchema,
        privacyClassification: ContactPointPrivacyClassificationSchema,
        provenance: ContactPointProvenanceSchema,
        validFrom: ContactPointTimestampSchema,
        verification: ContactPointVerificationSchema,
      }),
    ),
    type: Schema.Literal('CORRECT_CONTACT_POINT'),
  }),
]);
export type ContactPointMetadataChange = typeof ContactPointMetadataChangeSchema.Type;

export const UpdateContactPointPayloadSchema = Schema.Struct({
  change: ContactPointMetadataChangeSchema,
  contactPointRef: PartyContactPointRefSchema,
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  provenance: ContactPointProvenanceSchema,
});
export type UpdateContactPointPayload = typeof UpdateContactPointPayloadSchema.Type;

export const UpdateContactPointResultSchema = PartyContactPointSchema;
export type UpdateContactPointResult = typeof UpdateContactPointResultSchema.Type;
