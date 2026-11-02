import { tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { MarketRetirementImpactAssessment } from '../../shared/domain/market-retirement-impact.ts';

export const COMMERCE_MARKET_CATALOG_SCHEMA_NAME = 'commerce_market_catalog';

export const COMMERCE_MARKET_CATALOG_TABLE_INVENTORY = [
  'gateway_assertion_redemptions',
  'market_catalog_completeness_generations',
  'market_definition_revisions',
  'market_lifecycle_periods',
  'market_retirement_intents',
  'markets',
  'storefront_association_revisions',
  'storefront_associations',
] as const;

export const commerceMarketCatalogSchema = pgSchema(COMMERCE_MARKET_CATALOG_SCHEMA_NAME);

/** Global pre-authentication replay identities, independent of Tenant/SLE business rows. */
export const gatewayAssertionRedemptions = commerceMarketCatalogSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('market_catalog_gateway_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('market_catalog_gateway_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

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

/**
 * Durable cross-owner Market retirement intent. The retire Action writes it in its own transaction with the
 * self-outbox request; the owner Outbox Worker advances it stage by stage in short transactions, calling
 * Customer Context only between them. `stage` is compare-and-set by the owner routines.
 */
export const marketRetirementIntents = commerceMarketCatalogSchema.table.withRLS(
  'market_retirement_intents',
  {
    marketRetirementIntentId: uuid('market_retirement_intent_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    marketId: uuid('market_id').notNull(),
    sellingLegalEntityId: uuid('selling_legal_entity_id').notNull(),
    expectedRevision: integer('expected_revision').notNull(),
    expectedDefinitionRevisionId: uuid('expected_definition_revision_id').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    stage: text('stage').notNull(),
    failureReason: text('failure_reason'),
    retirementImpactAssessment: jsonb('retirement_impact_assessment').$type<MarketRetirementImpactAssessment>(),
    reservationRequest: jsonb('reservation_request'),
    transitionChanged: boolean('transition_changed'),
    retiredRevision: integer('retired_revision'),
    retiredDefinitionRevisionId: uuid('retired_definition_revision_id'),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actingPrincipalId: uuid('acting_principal_id').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('commerce_market_catalog_retirement_intents_scope_id_uk').on(table.tenantId, table.marketRetirementIntentId),
    unique('commerce_market_catalog_retirement_intents_invocation_uk').on(table.tenantId, table.actionInvocationId),
    uniqueIndex('commerce_market_catalog_retirement_intents_open_market_uk')
      .on(table.tenantId, table.marketId)
      .where(sql`${table.stage} not in ('COMPLETED', 'FAILED')`),
    foreignKey({
      columns: [table.tenantId, table.marketId],
      foreignColumns: [markets.tenantId, markets.marketId],
      name: 'commerce_market_catalog_retirement_intents_market_fk',
    }).onDelete('restrict'),
    check(
      'commerce_market_catalog_retirement_intents_stage_ck',
      sql`${table.stage} in ('REQUESTED', 'RESERVATION_REQUESTED', 'RESERVED', 'COMMIT_PENDING', 'RELEASE_PENDING', 'COMPLETED', 'FAILED')`,
    ),
    check(
      'commerce_market_catalog_retirement_intents_failure_ck',
      sql`(${table.stage} in ('RELEASE_PENDING', 'FAILED')) = (${table.failureReason} is not null) and (${table.failureReason} is null or ${table.failureReason} in ('replacement_impact_unresolved', 'impact_assessment_stale', 'impact_assessment_rejected', 'impact_assessment_unavailable', 'revision_conflict', 'invalid_lifecycle_transition'))`,
    ),
    check(
      'commerce_market_catalog_retirement_intents_reservation_ck',
      sql`${table.stage} in ('REQUESTED', 'FAILED') or ${table.reservationRequest} is not null`,
    ),
    check(
      'commerce_market_catalog_retirement_intents_revision_ck',
      sql`${table.expectedRevision} > 0 and (${table.retiredRevision} is null or ${table.retiredRevision} > 0)`,
    ),
    check(
      'commerce_market_catalog_retirement_intents_reason_ck',
      sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) between 1 and 500`,
    ),
    ...tenantRlsPolicies('commerce_market_catalog_retirement_intents_tenant', table.tenantId),
  ],
);

export const COMMERCE_MARKET_CATALOG_TABLES = [
  gatewayAssertionRedemptions,
  marketCatalogCompletenessGenerations,
  marketDefinitionRevisions,
  marketLifecyclePeriods,
  marketRetirementIntents,
  markets,
  storefrontAssociationRevisions,
  storefrontAssociations,
] as const;

const commerceMarketCatalogDatabaseSchema = {
  marketCatalogCompletenessGenerations,
  marketDefinitionRevisions,
  marketLifecyclePeriods,
  marketRetirementIntents,
  markets,
  storefrontAssociationRevisions,
  storefrontAssociations,
} as const;

/** Relational Queries v2 entry point for this owner. */
export const commerceMarketCatalogRelations = defineRelations(commerceMarketCatalogDatabaseSchema);
