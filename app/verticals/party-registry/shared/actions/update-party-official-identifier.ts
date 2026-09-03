// Canonical schema-only contract extracted from the generated update-party-official-identifier Action.
import { Schema } from 'effect';
import {
  IdentifierVerificationSchema,
  OfficialIdentifierAssertionStateSchema,
} from '../domain/identifier-contracts.ts';
import { IsoTimestampSchema } from '../domain/identity-contracts.ts';
import { PartyOfficialIdentifierRefSchema } from '../resources/party-official-identifier.ts';
import { PartyRefSchema } from '../resources/party.ts';

export const UpdatePartyOfficialIdentifierPayloadSchema = Schema.Struct({
  change: Schema.Union([
    Schema.Struct({
      expectedVerification: IdentifierVerificationSchema,
      type: Schema.Literal('SET_VERIFICATION'),
      verification: IdentifierVerificationSchema,
    }),
    Schema.Struct({ type: Schema.Literal('END_VALIDITY'), validTo: IsoTimestampSchema }),
  ]),
  evidenceRefs: Schema.Array(
    Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  identifierType: Schema.optionalKey(Schema.Never),
  namespace: Schema.optionalKey(Schema.Never),
  normalizedValue: Schema.optionalKey(Schema.Never),
  officialIdentifierRef: PartyOfficialIdentifierRefSchema,
  partyRef: Schema.optionalKey(Schema.Never),
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  value: Schema.optionalKey(Schema.Never),
});
export type UpdatePartyOfficialIdentifierPayload =
  typeof UpdatePartyOfficialIdentifierPayloadSchema.Type;

export const UpdatePartyOfficialIdentifierResultSchema = Schema.Struct({
  officialIdentifierRef: PartyOfficialIdentifierRefSchema,
  partyRef: PartyRefSchema,
  state: OfficialIdentifierAssertionStateSchema,
  validTo: Schema.NullOr(IsoTimestampSchema),
  verification: IdentifierVerificationSchema,
});
export type UpdatePartyOfficialIdentifierResult =
  typeof UpdatePartyOfficialIdentifierResultSchema.Type;
