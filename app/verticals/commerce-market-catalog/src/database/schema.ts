/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical database contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { MarketRetirementImpactAssessment } from '../../shared/domain/market-retirement-impact.ts';

export const COMMERCE_MARKET_CATALOG_SCHEMA_NAME = 'commerce_market_catalog';

export const COMMERCE_MARKET_CATALOG_TABLE_INVENTORY = [
  'market_catalog_completeness_generations',
  'market_definition_revisions',
  'market_lifecycle_periods',
  'markets',
  'storefront_association_revisions',
  'storefront_associations',
] as const;

export const commerceMarketCatalogSchema = pgSchema(COMMERCE_MARKET_CATALOG_SCHEMA_NAME);

const recordedAt = () => timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull();
const periodEnd = () => timestamp('effective_to', { withTimezone: true });
const periodStart = () => timestamp('effective_from', { withTimezone: true }).notNull();

export const markets = commerceMarketCatalogSchema.table.withRLS(
  'markets',
  {
    marketId: uuid('market_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    sellingLegalEntityId: uuid('selling_legal_entity_id').notNull(),
    businessCode: text('business_code').notNull(),
    currentDefinitionRevisionId: uuid('current_definition_revision_id'),
    currentDefinitionRevision: integer('current_definition_revision').default(1).notNull(),
    aggregateRevision: integer('aggregate_revision').default(1).notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: recordedAt(),
  },
  (table) => [
    unique('commerce_market_catalog_markets_scope_id_uk').on(table.tenantId, table.marketId),
    unique('commerce_market_catalog_markets_code_uk').on(table.tenantId, table.businessCode),
    index('commerce_market_catalog_markets_seller_idx').on(table.tenantId, table.sellingLegalEntityId),
    check('commerce_market_catalog_markets_code_ck', sql`${table.businessCode} ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'`),
    check(
      'commerce_market_catalog_markets_revision_ck',
      sql`${table.currentDefinitionRevision} > 0 and ${table.aggregateRevision} > 0`,
    ),
    ...tenantRlsPolicies('commerce_market_catalog_markets_tenant', table.tenantId),
  ],
);

export const marketDefinitionRevisions = commerceMarketCatalogSchema.table.withRLS(
  'market_definition_revisions',
  {
    marketDefinitionRevisionId: uuid('market_definition_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    marketId: uuid('market_id').notNull(),
    sellingLegalEntityId: uuid('selling_legal_entity_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    purpose: text('purpose').notNull(),
    channels: jsonb('channels').$type<readonly string[]>().notNull(),
    jurisdictions: jsonb('jurisdictions').$type<readonly Readonly<{ code: string; kind: string }>[]>().notNull(),
    supportedLocales: jsonb('supported_locales').$type<readonly string[]>().notNull(),
    effectiveFrom: periodStart(),
    effectiveTo: periodEnd(),
    changeReason: text('change_reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('commerce_market_catalog_definition_revisions_scope_id_uk').on(
      table.tenantId,
      table.marketDefinitionRevisionId,
    ),
    unique('commerce_market_catalog_definition_revisions_number_uk').on(
      table.tenantId,
      table.marketId,
      table.revisionNumber,
    ),
    unique('commerce_market_catalog_definition_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.marketId],
      foreignColumns: [markets.tenantId, markets.marketId],
      name: 'commerce_market_catalog_definition_revisions_market_fk',
    }).onDelete('restrict'),
    check('commerce_market_catalog_definition_revisions_number_ck', sql`${table.revisionNumber} > 0`),
    check(
      'commerce_market_catalog_definition_revisions_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'commerce_market_catalog_definition_revisions_purpose_ck',
      sql`${table.purpose} = btrim(${table.purpose}) and length(${table.purpose}) between 1 and 500`,
    ),
    check(
      'commerce_market_catalog_definition_revisions_reason_ck',
      sql`${table.changeReason} = btrim(${table.changeReason}) and length(${table.changeReason}) between 1 and 500`,
    ),
    ...tenantRlsPolicies('commerce_market_catalog_definition_revisions_tenant', table.tenantId),
  ],
);

export const marketLifecyclePeriods = commerceMarketCatalogSchema.table.withRLS(
  'market_lifecycle_periods',
  {
    marketLifecyclePeriodId: uuid('market_lifecycle_period_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    marketId: uuid('market_id').notNull(),
    sellingLegalEntityId: uuid('selling_legal_entity_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    lifecycle: text('lifecycle').notNull(),
    effectiveFrom: periodStart(),
    effectiveTo: periodEnd(),
    reason: text('reason').notNull(),
    retirementImpactAssessment: jsonb('retirement_impact_assessment').$type<MarketRetirementImpactAssessment>(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('commerce_market_catalog_lifecycle_scope_id_uk').on(table.tenantId, table.marketLifecyclePeriodId),
    unique('commerce_market_catalog_lifecycle_revision_uk').on(table.tenantId, table.marketId, table.revisionNumber),
    unique('commerce_market_catalog_lifecycle_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.marketId],
      foreignColumns: [markets.tenantId, markets.marketId],
      name: 'commerce_market_catalog_lifecycle_market_fk',
    }).onDelete('restrict'),
    check('commerce_market_catalog_lifecycle_revision_ck', sql`${table.revisionNumber} > 0`),
    check('commerce_market_catalog_lifecycle_state_ck', sql`${table.lifecycle} in ('ACTIVE', 'SUSPENDED', 'RETIRED')`),
    check(
      'commerce_market_catalog_lifecycle_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'commerce_market_catalog_lifecycle_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 500`,
    ),
    ...tenantRlsPolicies('commerce_market_catalog_lifecycle_tenant', table.tenantId),
  ],
);

export const storefrontAssociations = commerceMarketCatalogSchema.table.withRLS(
  'storefront_associations',
  {
    storefrontAssociationId: uuid('storefront_association_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    sellingLegalEntityId: uuid('selling_legal_entity_id').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    createdByActionInvocationId: uuid('created_by_action_invocation_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    createdAt: recordedAt(),
  },
  (table) => [
    unique('commerce_market_catalog_associations_scope_id_uk').on(table.tenantId, table.storefrontAssociationId),
    check('commerce_market_catalog_associations_revision_ck', sql`${table.currentRevision} > 0`),
    ...tenantRlsPolicies('commerce_market_catalog_associations_tenant', table.tenantId),
  ],
);

export const storefrontAssociationRevisions = commerceMarketCatalogSchema.table.withRLS(
  'storefront_association_revisions',
  {
    storefrontAssociationRevisionId: uuid('storefront_association_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    storefrontAssociationId: uuid('storefront_association_id').notNull(),
    revisionNumber: integer('revision_number').notNull(),
    marketId: uuid('market_id').notNull(),
    marketDefinitionRevisionId: uuid('market_definition_revision_id').notNull(),
    sellingLegalEntityId: uuid('selling_legal_entity_id').notNull(),
    storefrontAppId: text('storefront_app_id').notNull(),
    channel: text('channel').notNull(),
    effectiveFrom: periodStart(),
    effectiveTo: periodEnd(),
    provenanceKind: text('provenance_kind').notNull(),
    provenanceReference: text('provenance_reference').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    reason: text('reason').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    recordedAt: recordedAt(),
  },
  (table) => [
    unique('commerce_market_catalog_association_revisions_scope_id_uk').on(
      table.tenantId,
      table.storefrontAssociationRevisionId,
    ),
    unique('commerce_market_catalog_association_revisions_number_uk').on(
      table.tenantId,
      table.storefrontAssociationId,
      table.revisionNumber,
    ),
    unique('commerce_market_catalog_association_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.storefrontAssociationId],
      foreignColumns: [storefrontAssociations.tenantId, storefrontAssociations.storefrontAssociationId],
      name: 'commerce_market_catalog_association_revisions_association_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.marketId],
      foreignColumns: [markets.tenantId, markets.marketId],
      name: 'commerce_market_catalog_association_revisions_market_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.marketDefinitionRevisionId],
      foreignColumns: [marketDefinitionRevisions.tenantId, marketDefinitionRevisions.marketDefinitionRevisionId],
      name: 'commerce_market_catalog_association_revisions_definition_fk',
    }).onDelete('restrict'),
    index('commerce_market_catalog_association_revisions_eligibility_idx').on(
      table.tenantId,
      table.storefrontAppId,
      table.channel,
      table.effectiveFrom,
    ),
    check('commerce_market_catalog_association_revisions_number_ck', sql`${table.revisionNumber} > 0`),
    check('commerce_market_catalog_association_revisions_channel_ck', sql`${table.channel} in ('B2C', 'B2B')`),
    check(
      'commerce_market_catalog_association_revisions_period_ck',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    check(
      'commerce_market_catalog_association_revisions_storefront_ck',
      sql`${table.storefrontAppId} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
    check(
      'commerce_market_catalog_association_revisions_removal_ck',
      sql`${table.removedAt} is null or ${table.removedAt} >= ${table.effectiveFrom}`,
    ),
    ...tenantRlsPolicies('commerce_market_catalog_association_revisions_tenant', table.tenantId),
  ],
);

export const marketCatalogCompletenessGenerations = commerceMarketCatalogSchema.table.withRLS(
  'market_catalog_completeness_generations',
  {
    tenantId: uuid('tenant_id').primaryKey(),
    generation: integer('generation').default(0).notNull(),
    lastActionInvocationId: uuid('last_action_invocation_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('commerce_market_catalog_completeness_generation_ck', sql`${table.generation} >= 0`),
    ...tenantRlsPolicies('commerce_market_catalog_completeness_tenant', table.tenantId),
  ],
);

export const COMMERCE_MARKET_CATALOG_TABLES = [
  marketCatalogCompletenessGenerations,
  marketDefinitionRevisions,
  marketLifecyclePeriods,
  markets,
  storefrontAssociationRevisions,
  storefrontAssociations,
] as const;

const commerceMarketCatalogDatabaseSchema = {
  marketCatalogCompletenessGenerations,
  marketDefinitionRevisions,
  marketLifecyclePeriods,
  markets,
  storefrontAssociationRevisions,
  storefrontAssociations,
} as const;

/** Relational Queries v2 entry point for this owner. */
export const commerceMarketCatalogRelations = defineRelations(commerceMarketCatalogDatabaseSchema);
