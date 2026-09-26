/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { CatalogSelection } from '@app/catalog/domain/catalog-selection-evidence';

import type {
  CatalogToStockBinding,
  CatalogToStockBindingHistoryEntry,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryStockItems } from './stock-item-table.ts';

export const inventoryCatalogToStockBindings = inventorySchema.table.withRLS(
  'catalog_to_stock_bindings',
  {
    bindingId: uuid('binding_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    catalogSelection: jsonb('catalog_selection').$type<CatalogSelection>().notNull(),
    exactSelectionMeaningId: text('exact_selection_meaning_id').notNull(),
    exactSelectionKind: text('exact_selection_kind').notNull(),
    stockItemId: uuid('stock_item_id').notNull(),
    stockUnitModuleId: text('stock_unit_module_id').notNull(),
    stockUnitResourceId: uuid('stock_unit_resource_id').notNull(),
    stockUnitResourceType: text('stock_unit_resource_type').notNull(),
    stockUnitTenantId: uuid('stock_unit_tenant_id').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('inventory_catalog_to_stock_bindings_scope_id_uk').on(table.tenantId, table.bindingId),
    uniqueIndex('inventory_catalog_to_stock_bindings_selection_meaning_uk').on(
      table.tenantId,
      table.exactSelectionMeaningId,
    ),
    uniqueIndex('inventory_catalog_to_stock_bindings_stock_item_uk').on(table.tenantId, table.stockItemId),
    foreignKey({
      columns: [table.tenantId, table.stockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_catalog_to_stock_bindings_stock_item_fk',
    }).onDelete('restrict'),
    check(
      'inventory_catalog_to_stock_bindings_meaning_ck',
      sql`char_length(btrim(${table.exactSelectionMeaningId})) between 1 and 300 and ${table.exactSelectionKind} in ('PRODUCT_VARIANT', 'PACKAGE_OPTION', 'SET_VARIANT', 'CONFIGURED_SELECTION')`,
    ),
    check(
      'inventory_catalog_to_stock_bindings_unit_ck',
      sql`${table.stockUnitModuleId} = 'commerce.catalog' and ${table.stockUnitResourceType} = 'commerce.catalog.product-unit' and ${table.stockUnitTenantId} = ${table.tenantId}`,
    ),
    check('inventory_catalog_to_stock_bindings_revision_ck', sql`${table.currentRevision} >= 1`),
    ...tenantRlsPolicies('inventory_catalog_to_stock_bindings_tenant', table.tenantId),
  ],
);

export const inventoryCatalogToStockBindingHistory = inventorySchema.table.withRLS(
  'catalog_to_stock_binding_history',
  {
    bindingHistoryId: uuid('binding_history_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    bindingId: uuid('binding_id').notNull(),
    revision: integer('revision').notNull(),
    snapshot: jsonb('snapshot').$type<CatalogToStockBinding>().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
    transition: text('transition').$type<CatalogToStockBindingHistoryEntry['transition']>().notNull(),
    ownerEvidenceRef: text('owner_evidence_ref').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_catalog_to_stock_binding_history_scope_id_uk').on(table.tenantId, table.bindingHistoryId),
    uniqueIndex('inventory_catalog_to_stock_binding_history_revision_uk').on(
      table.tenantId,
      table.bindingId,
      table.revision,
    ),
    check('inventory_catalog_to_stock_binding_history_revision_ck', sql`${table.revision} >= 1`),
    check(
      'inventory_catalog_to_stock_binding_history_transition_ck',
      sql`${table.transition} in ('CORRECTED', 'ENDED', 'SUPERSEDED') and char_length(btrim(${table.ownerEvidenceRef})) between 1 and 300`,
    ),
    ...tenantRlsPolicies('inventory_catalog_to_stock_binding_history_tenant', table.tenantId),
  ],
);

export const inventoryCatalogToStockBindingHistoryImmutabilityContract = {
  currentRetention: 'CURRENT_ROW_REMOVED_AFTER_ARCHIVE',
  deleteTriggerName: 'inventory_catalog_to_stock_binding_history_no_delete_trg',
  functionName: 'inventory.reject_catalog_to_stock_binding_history_mutation',
  table: 'inventory.catalog_to_stock_binding_history',
  updateTriggerName: 'inventory_catalog_to_stock_binding_history_no_update_trg',
} as const;

export const inventoryCatalogToStockBindingCompatibilityTriggerContract = {
  bindingFunctionName: 'inventory.enforce_catalog_to_stock_binding_compatibility',
  bindingTable: 'inventory.catalog_to_stock_bindings',
  bindingTriggerName: 'inventory_catalog_to_stock_bindings_compatibility_trg',
  failureConstraints: {
    current: 'inventory_catalog_to_stock_bindings_target_current_ck',
    meaning: 'inventory_catalog_to_stock_bindings_target_meaning_ck',
    missing: 'inventory_catalog_to_stock_bindings_target_missing_ck',
    stockItemMutation: 'inventory_stock_items_current_binding_target_ck',
    unit: 'inventory_catalog_to_stock_bindings_target_unit_ck',
  },
  stockItemFunctionName: 'inventory.protect_current_catalog_to_stock_binding_target',
  stockItemTable: 'inventory.stock_items',
  stockItemTriggerName: 'inventory_stock_items_current_binding_target_trg',
  timing: 'BEFORE',
} as const;

export const inventoryCatalogToStockBindingMeaningKeyContract = {
  columns: ['tenant_id', 'exact_selection_meaning_id'],
  evidenceOnlyPath: 'catalog_selection.configuration.definition.revision',
  indexName: 'inventory_catalog_to_stock_bindings_selection_meaning_uk',
  provenanceColumn: 'catalog_selection',
} as const;
