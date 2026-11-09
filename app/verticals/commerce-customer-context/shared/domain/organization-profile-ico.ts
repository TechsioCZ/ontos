import { Schema } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { PartyOfficialIdentifierRefSchema } from '@app/party-registry/resources/party-official-identifier';
import { OfficialIdentifierInputSchema } from '@app/party-registry/domain/identifier-contracts';
import { ProfileInstantSchema } from './profile-contracts.ts';

const UuidSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('OrganizationProfileIcoOpaqueId')),
);
const DigitsSchema = Schema.String.check(Schema.isPattern(/^[0-9]{1,8}$/u));
const NormalizedSchema = Schema.String.check(Schema.isPattern(/^[0-9]{8}$/u));
const RevisionSchema = Schema.Int.check(Schema.isGreaterThan(0));
export const ORGANIZATION_PROFILE_ICO_FIELD_CONTRACT_VERSION =
  'commerce.customer-context.organization-ico-business-fields.v1';
export const ORGANIZATION_PROFILE_ICO_FIELDS = [
  'profileRef',
  'partyRef',
  'revision',
  'normalizedValue',
  'normalizerVersion',
  'originalInput.kind',
  'originalInput.digits',
  'operation',
  'effectiveAt',
  'effectiveTo',
  'isCurrent',
  'recordedAt',
  'provenance.ownerReceiptRef',
] as const;
export const OrganizationProfileIcoOwnerReceiptRefSchema = Schema.Union([
  Schema.TaggedStruct('CORE_ACTION_INVOCATION', { actionInvocationId: UuidSchema }),
  PartyOfficialIdentifierRefSchema,
]);
export const OrganizationProfileIcoAssertionSchema = Schema.Struct({
  effectiveAt: ProfileInstantSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(ProfileInstantSchema)),
  isCurrent: Schema.Boolean,
  normalizedValue: Schema.toEncoded(Schema.OptionFromNullOr(NormalizedSchema)),
  normalizerVersion: Schema.toEncoded(Schema.OptionFromNullOr(Schema.Literal('CZ:ICO:party-v1'))),
  operation: Schema.Literals(['SET', 'CORRECT', 'END']),
  originalInput: Schema.Union([
    Schema.Struct({ digits: DigitsSchema, kind: Schema.Literal('KNOWN') }),
    Schema.Struct({ kind: Schema.Literal('UNKNOWN') }),
  ]),
  partyRef: Schema.toEncoded(Schema.OptionFromNullOr(PartyRefSchema)),
  profileRef: CounterpartyPurchasingProfileRefSchema,
  provenance: Schema.Struct({ ownerReceiptRef: OrganizationProfileIcoOwnerReceiptRefSchema }),
  recordedAt: ProfileInstantSchema,
  revision: RevisionSchema,
});
export type OrganizationProfileIcoAssertion = typeof OrganizationProfileIcoAssertionSchema.Type;
export const OrganizationProfileIcoCurrentAssertionSchema = Schema.Struct({
  ...OrganizationProfileIcoAssertionSchema.fields,
  isCurrent: Schema.Literal(true),
  normalizedValue: NormalizedSchema,
  operation: Schema.Literals(['SET', 'CORRECT']),
});

const writeFields = {
  countryCode: Schema.Literal('CZ'),
  effectId: UuidSchema,
  effectiveAt: ProfileInstantSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  profileRef: CounterpartyPurchasingProfileRefSchema,
};
const numericFields = {
  identifier: OfficialIdentifierInputSchema.check(
    Schema.makeFilter((value) =>
      value.identifierType === 'ICO' && /^[0-9]{1,8}$/u.test(value.value)
        ? undefined
        : 'Only numeric Czech ICO input is in this field contract',
    ),
  ),
  originalInput: DigitsSchema,
};
export const ChangeOrganizationCustomerProfileIcoPayloadSchema = Schema.Union([
  Schema.Struct({ ...writeFields, ...numericFields, operation: Schema.Literal('SET') }),
  Schema.Struct({ ...writeFields, ...numericFields, operation: Schema.Literal('CORRECT') }),
  Schema.Struct({ ...writeFields, operation: Schema.Literal('END') }),
]).check(
  Schema.makeFilter((input) =>
    input.operation === 'END' || input.originalInput === input.identifier.value
      ? undefined
      : 'The original numeric digits must equal the accepted input',
  ),
);
export type ChangeOrganizationCustomerProfileIcoPayload = typeof ChangeOrganizationCustomerProfileIcoPayloadSchema.Type;
export const ChangeOrganizationCustomerProfileIcoResultSchema = Schema.Struct({
  assertion: OrganizationProfileIcoAssertionSchema,
  outcome: Schema.Literals(['APPLIED', 'REPLAY']),
});
export const OrganizationCustomerProfileIcoRequestSchema = Schema.Struct({
  actionInvocationId: Schema.optionalKey(UuidSchema),
  asOf: Schema.optionalKey(ProfileInstantSchema),
  profileRef: CounterpartyPurchasingProfileRefSchema,
});
export type OrganizationCustomerProfileIcoRequest = typeof OrganizationCustomerProfileIcoRequestSchema.Type;
export const OrganizationCustomerProfileIcoResponseSchema = Schema.Union([
  Schema.TaggedStruct('MIGRATION_REQUIRED', { profileRef: CounterpartyPurchasingProfileRefSchema }),
  Schema.TaggedStruct('PRESENT', {
    current: OrganizationProfileIcoCurrentAssertionSchema,
    history: Schema.Array(OrganizationProfileIcoAssertionSchema),
    revision: Schema.Int,
  }),
  Schema.TaggedStruct('ABSENT', { history: Schema.Array(OrganizationProfileIcoAssertionSchema), revision: Schema.Int }),
  Schema.TaggedStruct('RECEIPT', { assertion: OrganizationProfileIcoAssertionSchema }),
]);
export class OrganizationProfileIcoRejected extends Schema.TaggedError<OrganizationProfileIcoRejected>()(
  'OrganizationProfileIcoRejected',
  {
    code: Schema.Literals([
      'PROFILE_NOT_ADMISSIBLE',
      'PRIVACY_DENIED',
      'REVISION_CONFLICT',
      'EFFECT_CONFLICT',
      'INVALID_TRANSITION',
      'MIGRATION_REQUIRED',
      'PERSISTENCE_UNAVAILABLE',
      'STALE_PLAN',
      'PLAN_CONFLICT',
      'AUTHORITY_NOT_FENCED',
      'PERSONAL_INVENTORY_REQUIRES_FULL_AUTHORITY',
    ]),
    reason: Schema.String,
  },
) {}
