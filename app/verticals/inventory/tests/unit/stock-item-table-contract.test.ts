import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import {
  inventoryStockItemImmutabilityTriggerContract,
  inventoryStockItems,
} from '../../src/persistence/stock-item-table.ts';

it('persists one immutable exact Selection meaning and Unit per tenant-scoped Stock Item', () => {
  const config = getTableConfig(inventoryStockItems);

  expect(`${config.schema}.${config.name}`).toBe('inventory.stock_items');
  expect(config.enableRLS).toBe(true);
  expect(config.columns.map((column) => column.name)).toEqual([
    'created_at',
    'exact_selection_kind',
    'exact_selection_meaning_id',
    'lifecycle_state',
    'retired_at',
    'revision',
    'stock_item_id',
    'stock_unit_module_id',
    'stock_unit_resource_id',
    'stock_unit_resource_type',
    'stock_unit_tenant_id',
    'tenant_id',
  ]);
  expect(config.indexes.map((index) => index.config.name)).toEqual(
    expect.arrayContaining(['inventory_stock_items_scope_id_uk', 'inventory_stock_items_exact_meaning_uk']),
  );
  expect(config.checks.map((constraint) => constraint.name)).toEqual(
    expect.arrayContaining([
      'inventory_stock_items_lifecycle_ck',
      'inventory_stock_items_retirement_ck',
      'inventory_stock_items_meaning_ck',
      'inventory_stock_items_unit_ck',
    ]),
  );
  expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
  expect(inventoryStockItemImmutabilityTriggerContract).toEqual({
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
  });
});
