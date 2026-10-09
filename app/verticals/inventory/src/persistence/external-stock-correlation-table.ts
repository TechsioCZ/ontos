/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryStockItems } from './stock-item-table.ts';
import { inventoryStockLocations } from './stock-location-table.ts';

export const inventoryExternalStockCorrelationImmutabilityContract = {
  columns: [
    'correlation_id',
    'tenant_id',
    'customer_configuration_id',
    'issuer_backend_kind',
    'issuer_backend_id',
    'namespace',
    'external_scope',
    'identifier_kind',
    'external_value',
    'stock_item_id',
    'stock_location_id',
    'effective_from',
  ],
  comparison: 'IS DISTINCT FROM',
  deleteTriggerName: 'inventory_external_stock_correlations_no_delete_trg',
  errorCondition: 'check_violation',
  functionName: 'inventory.reject_external_stock_correlation_identity_mutation',
  table: 'inventory.external_stock_correlations',
  timing: 'BEFORE',
  updateTriggerName: 'inventory_external_stock_correlations_immutable_identity_trg',
} as const;

/** Migration hardening rejects every overlapping half-open period for one exact external key. */
export const inventoryExternalStockCorrelationNonoverlapContract = {
  errorCondition: 'exclusion_violation',
  event: 'INSERT OR UPDATE',
  functionName: 'inventory.enforce_external_stock_correlation_nonoverlap',
  period: '[effective_from, effective_to)',
  table: 'inventory.external_stock_correlations',
  triggerName: 'inventory_external_stock_correlations_nonoverlap_trg',
} as const;

export const inventoryExternalStockCorrelations = inventorySchema.table.withRLS(
  'external_stock_correlations',
  {
    correlationId: uuid('correlation_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    issuerBackendKind: text('issuer_backend_kind').notNull(),
    issuerBackendId: text('issuer_backend_id').notNull(),
    namespace: text('namespace').notNull(),
    externalScope: text('external_scope').notNull(),
    identifierKind: text('identifier_kind').notNull(),
    externalValue: text('external_value').notNull(),
    stockItemId: uuid('stock_item_id'),
    stockLocationId: uuid('stock_location_id'),
    lifecycleState: text('lifecycle_state').default('CURRENT').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    ownerEvidenceRef: text('owner_evidence_ref').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    revision: integer('revision').default(1).notNull(),
  },
  (table) => [
    uniqueIndex('inventory_external_stock_correlations_scope_id_uk').on(table.tenantId, table.correlationId),
    uniqueIndex('inventory_external_stock_correlations_current_key_uk')
      .on(
        table.tenantId,
        table.customerConfigurationId,
        table.issuerBackendKind,
        table.issuerBackendId,
        table.namespace,
        table.externalScope,
        table.identifierKind,
        table.externalValue,
      )
      .where(sql`${table.lifecycleState} = 'CURRENT' and ${table.effectiveTo} is null`),
    index('inventory_external_stock_correlations_item_idx').on(table.tenantId, table.stockItemId),
    index('inventory_external_stock_correlations_location_idx').on(table.tenantId, table.stockLocationId),
    foreignKey({
      columns: [table.tenantId, table.stockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_external_stock_correlations_item_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockLocationId],
      foreignColumns: [inventoryStockLocations.tenantId, inventoryStockLocations.stockLocationId],
      name: 'inventory_external_stock_correlations_location_fk',
    }).onDelete('restrict'),
    check(
      'inventory_external_stock_correlations_key_ck',
      sql`length(btrim(${table.customerConfigurationId})) between 1 and 300 and ${table.issuerBackendKind} in ('external_business_system', 'ontos_wms') and length(btrim(${table.issuerBackendId})) between 1 and 300 and length(btrim(${table.namespace})) between 1 and 300 and length(btrim(${table.externalScope})) between 1 and 300 and ${table.identifierKind} in ('ITEM', 'LOCATION') and length(btrim(${table.externalValue})) between 1 and 300`,
    ),
    check(
      'inventory_external_stock_correlations_target_ck',
      sql`(${table.identifierKind} = 'ITEM' and ${table.stockItemId} is not null and ${table.stockLocationId} is null) or (${table.identifierKind} = 'LOCATION' and ${table.stockItemId} is null and ${table.stockLocationId} is not null)`,
    ),
    check(
      'inventory_external_stock_correlations_lifecycle_ck',
      sql`(${table.lifecycleState} = 'CURRENT' and ${table.effectiveTo} is null) or (${table.lifecycleState} = 'ENDED' and ${table.effectiveTo} is not null and ${table.effectiveFrom} < ${table.effectiveTo})`,
    ),
    check(
      'inventory_external_stock_correlations_evidence_ck',
      sql`length(btrim(${table.ownerEvidenceRef})) between 1 and 300`,
    ),
    check('inventory_external_stock_correlations_revision_ck', sql`${table.revision} >= 1`),
    ...tenantRlsPolicies('inventory_external_stock_correlations_tenant', table.tenantId),
  ],
);

export const INVENTORY_EXTERNAL_STOCK_CORRELATION_TABLES = [inventoryExternalStockCorrelations] as const;
