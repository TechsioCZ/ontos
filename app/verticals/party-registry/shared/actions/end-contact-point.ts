// Canonical schema-only contract extracted from the generated end-contact-point Action.
import { Schema } from 'effect';

import { PartyClientSourceReferenceSchema } from '../domain/identity-contracts.ts';

import {
  AddressPurposeTargetSchema,
  ContactPointProvenanceSchema,
  ContactPointTimestampSchema,
} from '../domain/contact-point.ts';
import { PartyContactPointRefSchema } from '../resources/party-contact-point.ts';

const EndTargetSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('WHOLE_CONTACT_POINT') }),
  Schema.Struct({
    target: AddressPurposeTargetSchema,
    type: Schema.Literal('ADDRESS_PURPOSE'),
  }),
]);

export const EndContactPointPayloadSchema = Schema.Struct({
  sourceReference: Schema.optionalKey(PartyClientSourceReferenceSchema),
  contactPointRef: PartyContactPointRefSchema,
  effectiveEnd: ContactPointTimestampSchema,
  provenance: ContactPointProvenanceSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  target: EndTargetSchema,
});
export type EndContactPointPayload = typeof EndContactPointPayloadSchema.Type;

export { PartyContactPointSchema as EndContactPointResultSchema } from '../domain/contact-point.ts';
