import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { inventorySchema } from '../database/inventory-schema.ts';

export const inventoryStockItemImmutabilityTriggerContract = {
  columns: [
    'stock_item_id',
    'tenant_id',
    'exact_selection_meaning_id',
    'exact_selection_kind',
    'stock_unit_module_id',
    'stock_unit_resource_id',
    'stock_unit_resource_type',
    'stock_unit_tenant_id',
  ],
  comparison: 'IS DISTINCT FROM',
  errorCondition: 'check_violation',
  event: 'UPDATE',
  functionName: 'inventory.reject_stock_item_meaning_mutation',
  table: 'inventory.stock_items',
  timing: 'BEFORE',
  triggerName: 'inventory_stock_items_immutable_meaning_trg',
} as const;

export const inventoryStockItems = inventorySchema.table.withRLS(
  'stock_items',
  {
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    exactSelectionKind: text('exact_selection_kind').notNull(),
    exactSelectionMeaningId: text('exact_selection_meaning_id').notNull(),
    lifecycleState: text('lifecycle_state').default('CURRENT').notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    revision: integer('revision').default(1).notNull(),
    stockItemId: uuid('stock_item_id').primaryKey(),
    stockUnitModuleId: text('stock_unit_module_id').notNull(),
    stockUnitResourceId: uuid('stock_unit_resource_id').notNull(),
    stockUnitResourceType: text('stock_unit_resource_type').notNull(),
    stockUnitTenantId: uuid('stock_unit_tenant_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    uniqueIndex('inventory_stock_items_scope_id_uk').on(table.tenantId, table.stockItemId),
    uniqueIndex('inventory_stock_items_exact_meaning_uk').on(table.tenantId, table.exactSelectionMeaningId),
    index('inventory_stock_items_current_idx')
      .on(table.tenantId, table.lifecycleState)
      .where(sql`${table.lifecycleState} = 'CURRENT'`),
    check(
      'inventory_stock_items_meaning_ck',
      sql`char_length(btrim(${table.exactSelectionMeaningId})) between 1 and 300 and ${table.exactSelectionKind} in ('PRODUCT_VARIANT', 'PACKAGE_OPTION', 'SET_VARIANT', 'CONFIGURED_SELECTION')`,
    ),
    check(
      'inventory_stock_items_unit_ck',
      sql`${table.stockUnitModuleId} = 'commerce.catalog' and ${table.stockUnitResourceType} = 'commerce.catalog.product-unit' and ${table.stockUnitTenantId} = ${table.tenantId}`,
    ),
    check('inventory_stock_items_revision_ck', sql`${table.revision} >= 1`),
    check('inventory_stock_items_lifecycle_ck', sql`${table.lifecycleState} in ('CURRENT', 'RETIRED')`),
    check(
      'inventory_stock_items_retirement_ck',
      sql`(${table.lifecycleState} = 'CURRENT' and ${table.retiredAt} is null) or (${table.lifecycleState} = 'RETIRED' and ${table.retiredAt} is not null)`,
    ),
    ...tenantRlsPolicies('inventory_stock_items_tenant', table.tenantId),
  ],
);
