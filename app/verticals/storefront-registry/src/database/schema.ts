/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const STOREFRONT_REGISTRY_SCHEMA_NAME = 'storefront_registry';
export const STOREFRONT_REGISTRY_TABLE_INVENTORY = [
  'storefront_applications',
  'storefront_application_revisions',
  'storefront_registry_generations',
] as const;

export const storefrontRegistrySchema = pgSchema(STOREFRONT_REGISTRY_SCHEMA_NAME);

export const storefrontApplications = storefrontRegistrySchema.table.withRLS(
  'storefront_applications',
  {
    storefrontApplicationId: uuid('storefront_application_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    storefrontAppId: text('storefront_app_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('storefront_registry_applications_scope_id_uk').on(table.tenantId, table.storefrontApplicationId),
    unique('storefront_registry_applications_app_id_uk').on(table.tenantId, table.storefrontAppId),
    check('storefront_registry_applications_revision_ck', sql`${table.currentRevision} > 0`),
    check('storefront_registry_applications_app_id_ck', sql`${table.storefrontAppId} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    ...tenantRlsPolicies('storefront_registry_applications_tenant', table.tenantId),
  ],
);

export const storefrontApplicationRevisions = storefrontRegistrySchema.table.withRLS(
  'storefront_application_revisions',
  {
    storefrontApplicationRevisionId: uuid('storefront_application_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    storefrontApplicationId: uuid('storefront_application_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    allowedChannels: jsonb('allowed_channels').$type<readonly ('B2B' | 'B2C')[]>().notNull(),
    lifecycle: text('lifecycle').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('storefront_registry_revisions_scope_id_uk').on(table.tenantId, table.storefrontApplicationRevisionId),
    unique('storefront_registry_revisions_number_uk').on(
      table.tenantId,
      table.storefrontApplicationId,
      table.revisionNumber,
    ),
    unique('storefront_registry_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.storefrontApplicationId],
      foreignColumns: [storefrontApplications.tenantId, storefrontApplications.storefrontApplicationId],
      name: 'storefront_registry_revisions_application_fk',
    }).onDelete('restrict'),
    index('storefront_registry_revisions_effective_idx').on(
      table.tenantId,
      table.storefrontApplicationId,
      table.effectiveFrom,
    ),
    check('storefront_registry_revisions_number_ck', sql`${table.revisionNumber} > 0`),
    check(
      'storefront_registry_revisions_lifecycle_ck',
      sql`${table.lifecycle} in ('DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED')`,
    ),
    check(
      'storefront_registry_revisions_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'storefront_registry_revisions_channels_ck',
      sql`jsonb_typeof(${table.allowedChannels}) = 'array' and jsonb_array_length(${table.allowedChannels}) > 0`,
    ),
    check(
      'storefront_registry_revisions_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 500`,
    ),
    ...tenantRlsPolicies('storefront_registry_revisions_tenant', table.tenantId),
  ],
);

export const storefrontRegistryGenerations = storefrontRegistrySchema.table.withRLS(
  'storefront_registry_generations',
  {
    tenantId: uuid('tenant_id').primaryKey(),
    generation: integer('generation').default(0).notNull(),
    lastActionInvocationId: uuid('last_action_invocation_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('storefront_registry_generations_generation_ck', sql`${table.generation} >= 0`),
    ...tenantRlsPolicies('storefront_registry_generations_tenant', table.tenantId),
  ],
);

export const STOREFRONT_REGISTRY_TABLES = [
  storefrontApplicationRevisions,
  storefrontApplications,
  storefrontRegistryGenerations,
] as const;
