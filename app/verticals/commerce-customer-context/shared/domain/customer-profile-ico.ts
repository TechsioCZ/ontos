import { OfficialIdentifierInputSchema } from '@app/party-registry/domain/identifier-contracts';
import { SourceProcessingEligibilityRequestSchema } from '@app/privacy/api';
import { LegacyIcoInventoryAssertionSchema } from '@app/party-registry/apis/legacy-ico-inventory';
import { Schema } from 'effect';
import { CustomerProfileReadRequestSchema } from '../apis/customer-profile-read.ts';
import { ProfileBoundedKeySchema, ProfileInstantSchema } from '../domain/profile-contracts.ts';

const RevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ProvenanceSchema = Schema.Struct({
  assertionId: ProfileBoundedKeySchema,
  countryCode: Schema.Literal('CZ'),
  evidenceRef: ProfileBoundedKeySchema,
  source: ProfileBoundedKeySchema,
  sourceContext: SourceProcessingEligibilityRequestSchema.fields.source,
  sourceRevision: ProfileBoundedKeySchema,
});
const changeFields = {
  ...CustomerProfileReadRequestSchema.fields,
  effectId: ProfileBoundedKeySchema,
  effectiveAt: ProfileInstantSchema,
  expectedRevision: RevisionSchema,
  provenance: ProvenanceSchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
};
const valueFields = {
  identifier: OfficialIdentifierInputSchema.check(
    Schema.makeFilter((value) => (value.identifierType === 'ICO' ? undefined : 'only Czech ICO is supported')),
  ),
  originalInput: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
};
export const ChangeCustomerProfileIcoPayloadSchema = Schema.Union([
  Schema.Struct({ ...changeFields, ...valueFields, operation: Schema.Literal('SET') }),
  Schema.Struct({ ...changeFields, ...valueFields, operation: Schema.Literal('CORRECT') }),
  Schema.Struct({ ...changeFields, operation: Schema.Literal('END') }),
]).check(
  Schema.makeFilter((input) =>
    input.operation === 'END' || input.originalInput.trim() === input.identifier.value
      ? undefined
      : 'original input must be the accepted Czech input',
  ),
);
export type ChangeCustomerProfileIcoPayload = typeof ChangeCustomerProfileIcoPayloadSchema.Type;

export const CustomerProfileIcoAssertionSchema = Schema.Struct({
  actorPrincipalId: Schema.toEncoded(
    Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ProfileIcoActorPrincipalId')),
  ),
  effectId: ProfileBoundedKeySchema,
  effectiveAt: ProfileInstantSchema,
  normalizedValue: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String.check(Schema.isPattern(/^[0-9]{8}$/u)))),
  normalizerVersion: Schema.toEncoded(Schema.OptionFromNullOr(Schema.Literal('CZ:ICO:party-v1'))),
  operation: Schema.Literals(['SET', 'CORRECT', 'END']),
  originalInput: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
  provenance: Schema.Struct({
    ...ProvenanceSchema.fields,
    legacy: Schema.optionalKey(LegacyIcoInventoryAssertionSchema),
    source: Schema.toEncoded(Schema.OptionFromNullOr(ProvenanceSchema.fields.source)),
  }),
  reason: changeFields.reason,
  recordedAt: ProfileInstantSchema,
  revision: RevisionSchema,
});
export const ChangeCustomerProfileIcoResultSchema = Schema.Struct({
  assertion: CustomerProfileIcoAssertionSchema,
  outcome: Schema.Literals(['APPLIED', 'REPLAY']),
  profileRef: CustomerProfileReadRequestSchema.fields.profileRef,
});
export class CustomerProfileIcoRejected extends Schema.TaggedError<CustomerProfileIcoRejected>()(
  'CustomerProfileIcoRejected',
  {
    code: Schema.Literals([
      'PROFILE_NOT_FOUND',
      'PROFILE_INELIGIBLE',
      'REVISION_CONFLICT',
      'EFFECT_CONFLICT',
      'INVALID_TRANSITION',
      'MIGRATION_REQUIRED',
      'PRIVACY_DENIED',
      'PERSISTENCE_UNAVAILABLE',
    ]),
    reason: Schema.String,
  },
) {}
