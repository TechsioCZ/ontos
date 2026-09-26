/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { StockSharingEligibility } from '../../shared/domain/stock-sharing-eligibility.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

export const inventoryStockSharingEligibilities = inventorySchema.table.withRLS(
  'stock_sharing_eligibilities',
  {
    eligibilityId: uuid('eligibility_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    ownerConfigurationId: uuid('owner_configuration_id').notNull(),
    stockPositionId: uuid('stock_position_id').notNull(),
    sellingLegalEntityId: uuid('selling_legal_entity_id').notNull(),
    channel: text('channel').notNull(),
    commerceMarketId: text('commerce_market_id'),
    storefrontAppId: text('storefront_app_id'),
    commerceValidationEvidenceRef: text('commerce_validation_evidence_ref').notNull(),
    commerceValidationObservedAt: timestamp('commerce_validation_observed_at', { withTimezone: true }).notNull(),
    lifecycleState: text('lifecycle_state').default('CURRENT').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    currentRevision: integer('current_revision').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_stock_sharing_eligibilities_scope_id_uk').on(table.tenantId, table.eligibilityId),
    index('inventory_stock_sharing_eligibilities_current_position_idx')
      .on(table.tenantId, table.customerConfigurationId, table.ownerConfigurationId, table.stockPositionId)
      .where(sql`${table.lifecycleState} = 'CURRENT' and ${table.effectiveTo} is null`),
    foreignKey({
      columns: [table.tenantId, table.ownerConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_stock_sharing_eligibilities_backend_configuration_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockPositionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_stock_sharing_eligibilities_position_fk',
    }).onDelete('restrict'),
    check(
      'inventory_stock_sharing_eligibilities_subject_ck',
      sql`${table.channel} in ('B2C', 'B2B') and char_length(btrim(${table.commerceValidationEvidenceRef})) between 1 and 300 and (${table.commerceMarketId} is null or char_length(btrim(${table.commerceMarketId})) between 1 and 300) and (${table.storefrontAppId} is null or ${table.storefrontAppId} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')`,
    ),
    check(
      'inventory_stock_sharing_eligibilities_lifecycle_ck',
      sql`(${table.lifecycleState} = 'CURRENT' and ${table.effectiveTo} is null) or (${table.lifecycleState} = 'ENDED' and ${table.effectiveTo} is not null and ${table.effectiveFrom} < ${table.effectiveTo})`,
    ),
    check('inventory_stock_sharing_eligibilities_revision_ck', sql`${table.currentRevision} >= 1`),
    ...tenantRlsPolicies('inventory_stock_sharing_eligibilities_tenant', table.tenantId),
  ],
);

export const inventoryStockSharingEligibilityHistory = inventorySchema.table.withRLS(
  'stock_sharing_eligibility_history',
  {
    historyId: uuid('history_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    eligibilityId: uuid('eligibility_id').notNull(),
    revision: integer('revision').notNull(),
    snapshot: jsonb('snapshot').$type<StockSharingEligibility>().notNull(),
    transitionAt: timestamp('transition_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_stock_sharing_eligibility_history_scope_id_uk').on(table.tenantId, table.historyId),
    uniqueIndex('inventory_stock_sharing_eligibility_history_revision_uk').on(
      table.tenantId,
      table.eligibilityId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.eligibilityId],
      foreignColumns: [inventoryStockSharingEligibilities.tenantId, inventoryStockSharingEligibilities.eligibilityId],
      name: 'inventory_stock_sharing_eligibility_history_eligibility_fk',
    }).onDelete('restrict'),
    check('inventory_stock_sharing_eligibility_history_revision_ck', sql`${table.revision} >= 1`),
    ...tenantRlsPolicies('inventory_stock_sharing_eligibility_history_tenant', table.tenantId),
  ],
);

/** Migration hardening validates that Position and backend belong to this exact Customer Configuration scope. */
export const inventoryStockSharingEligibilityScopeTriggerContract = {
  constraintNames: {
    backend: 'inventory_stock_sharing_eligibilities_backend_scope_ck',
    position: 'inventory_stock_sharing_eligibilities_position_scope_ck',
  },
  event: 'INSERT OR UPDATE',
  functionName: 'inventory.enforce_stock_sharing_eligibility_scope',
  positionRequiredLifecycle: 'CURRENT',
  table: 'inventory.stock_sharing_eligibilities',
  timing: 'BEFORE',
  triggerName: 'inventory_stock_sharing_eligibilities_scope_trg',
} as const;

export const inventoryStockSharingEligibilityIdentityImmutabilityContract = {
  columns: ['eligibility_id', 'tenant_id', 'customer_configuration_id', 'owner_configuration_id', 'stock_position_id'],
  comparison: 'IS DISTINCT FROM',
  errorCondition: 'check_violation',
  event: 'UPDATE OR DELETE',
  functionName: 'inventory.reject_stock_sharing_eligibility_identity_mutation',
  table: 'inventory.stock_sharing_eligibilities',
  timing: 'BEFORE',
  triggerName: 'inventory_stock_sharing_eligibilities_immutable_identity_trg',
} as const;

export const inventoryStockSharingEligibilityHistoryImmutabilityContract = {
  deleteTriggerName: 'inventory_stock_sharing_eligibility_history_no_delete_trg',
  functionName: 'inventory.reject_stock_sharing_eligibility_history_mutation',
  table: 'inventory.stock_sharing_eligibility_history',
  updateTriggerName: 'inventory_stock_sharing_eligibility_history_no_update_trg',
} as const;

export const INVENTORY_STOCK_SHARING_ELIGIBILITY_TABLES = [
  inventoryStockSharingEligibilityHistory,
  inventoryStockSharingEligibilities,
] as const;
