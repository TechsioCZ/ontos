/* eslint-disable max-classes-per-file -- The engagement boundary owns one closed error vocabulary. */
import { Schema } from 'effect';
import { CounterpartyRefSchema, PartyRefSchema } from '../party-registry-references.ts';
import { OrganizationEngagementProfileRefSchema } from '../resources/organization-engagement-profile.ts';
import { PersonEngagementProfileRefSchema } from '../resources/person-engagement-profile.ts';

export const EngagementProfileIdSchema = Schema.String.check(Schema.isUUID());
export const EngagementIsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
);

const commonFields = {
  archivedAt: Schema.NullOr(EngagementIsoTimestampSchema),
  counterpartyRef: Schema.NullOr(CounterpartyRefSchema),
  createdAt: EngagementIsoTimestampSchema,
  partyRef: PartyRefSchema,
  updatedAt: EngagementIsoTimestampSchema,
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

export class EngagementProfileNotFound extends Schema.TaggedError<EngagementProfileNotFound>()(
  'EngagementProfileNotFound',
  {
    code: Schema.Literal('contacts_engagement_profile_not_found'),
    profileId: EngagementProfileIdSchema,
    reason: Schema.String,
  },
) {}

export class EngagementProfileConflict extends Schema.TaggedError<EngagementProfileConflict>()(
  'EngagementProfileConflict',
  {
    code: Schema.Literals([
      'contacts_counterparty_customer_role_required',
      'contacts_engagement_profile_already_exists',
      'contacts_engagement_profile_lifecycle_conflict',
      'contacts_party_counterparty_mismatch',
      'contacts_party_alias_requires_canonical_reference',
      'contacts_party_archived',
      'contacts_party_type_mismatch',
    ]),
    reason: Schema.String,
  },
) {}

export class EngagementProfilePersistenceUnavailable extends Schema.TaggedError<EngagementProfilePersistenceUnavailable>()(
  'EngagementProfilePersistenceUnavailable',
  {
    code: Schema.Literal('contacts_engagement_profile_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

export class PartyRegistryReferenceUnavailable extends Schema.TaggedError<PartyRegistryReferenceUnavailable>()(
  'PartyRegistryReferenceUnavailable',
  {
    code: Schema.Literal('party_registry_reference_unavailable'),
    reason: Schema.String,
  },
) {}
