import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { CounterpartyRefSchema, PartyRefSchema } from '../party-registry-references.ts';
import { OrganizationEngagementProfileRefSchema } from '../resources/organization-engagement-profile.ts';
import { PersonEngagementProfileRefSchema } from '../resources/person-engagement-profile.ts';

export {
  EngagementProfileIdSchema,
  EngagementProfileNotFound,
} from './engagement-profile-errors/not-found.ts';
export { EngagementProfileConflict } from './engagement-profile-errors/conflict.ts';
export { EngagementProfilePersistenceUnavailable } from './engagement-profile-errors/persistence-unavailable.ts';
export { PartyRegistryReferenceUnavailable } from './engagement-profile-errors/party-registry-reference-unavailable.ts';

export const EngagementIsoTimestampSchema = Schema.DateTimeUtcFromString;
const EngagementIsoTimestampJsonSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'invalid UTC calendar timestamp';
  }),
).pipe(
  Schema.decode({
    decode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
  }),
);

const commonFields = {
  archivedAt: Schema.toEncoded(Schema.OptionFromNullOr(EngagementIsoTimestampJsonSchema)),
  counterpartyRef: Schema.toEncoded(Schema.OptionFromNullOr(CounterpartyRefSchema)),
  createdAt: EngagementIsoTimestampJsonSchema,
  partyRef: PartyRefSchema,
  updatedAt: EngagementIsoTimestampJsonSchema,
} as const;

export const OrganizationEngagementProfileSchema = Schema.Struct({
  ...commonFields,
  profileRef: OrganizationEngagementProfileRefSchema,
});
export type OrganizationEngagementProfile = typeof OrganizationEngagementProfileSchema.Type;

export const PersonEngagementProfileSchema = Schema.Struct({
  ...commonFields,
  profileRef: PersonEngagementProfileRefSchema,
});
export type PersonEngagementProfile = typeof PersonEngagementProfileSchema.Type;

export const AttachOrganizationEngagementPayloadSchema = Schema.Struct({
  counterpartyRef: Schema.optionalKey(CounterpartyRefSchema),
  partyRef: PartyRefSchema,
});
export type AttachOrganizationEngagementPayload =
  typeof AttachOrganizationEngagementPayloadSchema.Type;

export const AttachPersonEngagementPayloadSchema = Schema.Struct({
  counterpartyRef: Schema.optionalKey(CounterpartyRefSchema),
  partyRef: PartyRefSchema,
});
export type AttachPersonEngagementPayload = typeof AttachPersonEngagementPayloadSchema.Type;

export const OrganizationEngagementLifecyclePayloadSchema = Schema.Struct({
  profileRef: OrganizationEngagementProfileRefSchema,
});
export type OrganizationEngagementLifecyclePayload =
  typeof OrganizationEngagementLifecyclePayloadSchema.Type;

export const PersonEngagementLifecyclePayloadSchema = Schema.Struct({
  profileRef: PersonEngagementProfileRefSchema,
});
export type PersonEngagementLifecyclePayload = typeof PersonEngagementLifecyclePayloadSchema.Type;
