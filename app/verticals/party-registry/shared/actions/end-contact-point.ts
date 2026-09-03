// Canonical schema-only contract extracted from the generated end-contact-point Action.
import { Schema } from 'effect';
import {
  AddressPurposeTargetSchema,
  ContactPointProvenanceSchema,
  ContactPointTimestampSchema,
  PartyContactPointSchema,
} from '../domain/contact-point.ts';
import { PartyContactPointRefSchema } from '../resources/party-contact-point.ts';

const EndTargetSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('WHOLE_CONTACT_POINT') }),
  Schema.Struct({ target: AddressPurposeTargetSchema, type: Schema.Literal('ADDRESS_PURPOSE') }),
]);

export const EndContactPointPayloadSchema = Schema.Struct({
  contactPointRef: PartyContactPointRefSchema,
  effectiveEnd: ContactPointTimestampSchema,
  provenance: ContactPointProvenanceSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  target: EndTargetSchema,
});
export type EndContactPointPayload = typeof EndContactPointPayloadSchema.Type;

export const EndContactPointResultSchema = PartyContactPointSchema;
export type EndContactPointResult = typeof EndContactPointResultSchema.Type;
