import { tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  check,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const CONTACTS_SCHEMA_NAME = 'contacts';

export const CONTACTS_TABLE_INVENTORY = [
  'gateway_assertion_redemptions',
  'organization_engagement_profiles',
  'person_engagement_profiles',
] as const;

export const contactsSchema = pgSchema(CONTACTS_SCHEMA_NAME);

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const organizationEngagementProfiles = contactsSchema.table.withRLS(
  'organization_engagement_profiles',
  {
    engagementProfileId: uuid('engagement_profile_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    partyResourceId: text('party_resource_id').notNull(),
    counterpartyResourceId: text('counterparty_resource_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (table) => [
    unique('contacts_organization_engagement_profiles_tenant_id_uk').on(
      table.tenantId,
      table.engagementProfileId,
    ),
    uniqueIndex('contacts_organization_engagement_profiles_counterparty_uk').on(
      table.tenantId,
      table.counterpartyResourceId,
    ),
    uniqueIndex('contacts_organization_engagement_profiles_party_uk').on(
      table.tenantId,
      table.partyResourceId,
    ),
    index('contacts_organization_engagement_profiles_active_idx')
      .on(table.tenantId, table.counterpartyResourceId)
      .where(sql`${table.archivedAt} is null`),
    check(
      'contacts_organization_engagement_profiles_party_resource_id_ck',
      sql`${table.partyResourceId} = btrim(${table.partyResourceId}) and length(${table.partyResourceId}) > 0`,
    ),
    check(
      'contacts_organization_engagement_profiles_counterparty_resource_id_ck',
      sql`${table.counterpartyResourceId} = btrim(${table.counterpartyResourceId}) and length(${table.counterpartyResourceId}) > 0`,
    ),
    ...tenantRlsPolicies('contacts_organization_engagement_profiles_tenant', table.tenantId),
  ],
);

export const personEngagementProfiles = contactsSchema.table.withRLS(
  'person_engagement_profiles',
  {
    engagementProfileId: uuid('engagement_profile_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    partyResourceId: text('party_resource_id').notNull(),
    counterpartyResourceId: text('counterparty_resource_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (table) => [
    unique('contacts_person_engagement_profiles_tenant_id_uk').on(
      table.tenantId,
      table.engagementProfileId,
    ),
    uniqueIndex('contacts_person_engagement_profiles_party_counterparty_uk').on(
      table.tenantId,
      table.partyResourceId,
      table.counterpartyResourceId,
    ),
    uniqueIndex('contacts_person_engagement_profiles_party_only_uk')
      .on(table.tenantId, table.partyResourceId)
      .where(sql`${table.counterpartyResourceId} is null`),
    index('contacts_person_engagement_profiles_active_idx')
      .on(table.tenantId, table.counterpartyResourceId, table.partyResourceId)
      .where(sql`${table.archivedAt} is null`),
    check(
      'contacts_person_engagement_profiles_party_resource_id_ck',
      sql`${table.partyResourceId} = btrim(${table.partyResourceId}) and length(${table.partyResourceId}) > 0`,
    ),
    check(
      'contacts_person_engagement_profiles_counterparty_resource_id_ck',
      sql`${table.counterpartyResourceId} = btrim(${table.counterpartyResourceId}) and length(${table.counterpartyResourceId}) > 0`,
    ),
    ...tenantRlsPolicies('contacts_person_engagement_profiles_tenant', table.tenantId),
  ],
);

export const gatewayAssertionRedemptions = contactsSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('contacts_gateway_assertion_redemptions_identity_uk').on(
      table.issuer,
      table.audience,
      table.jti,
    ),
    index('contacts_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

export const contactsDatabaseSchema = {
  gatewayAssertionRedemptions,
  organizationEngagementProfiles,
  personEngagementProfiles,
} as const;

export const CONTACTS_TABLES = [
  gatewayAssertionRedemptions,
  organizationEngagementProfiles,
  personEngagementProfiles,
] as const;

export type OrganizationEngagementProfileRecord =
  typeof organizationEngagementProfiles.$inferSelect;
export type NewOrganizationEngagementProfileRecord =
  typeof organizationEngagementProfiles.$inferInsert;
export type PersonEngagementProfileRecord = typeof personEngagementProfiles.$inferSelect;
export type NewPersonEngagementProfileRecord = typeof personEngagementProfiles.$inferInsert;

/** Relational Queries v2 entry point for the Contacts owner. */
export const contactsRelations = defineRelations(contactsDatabaseSchema);
