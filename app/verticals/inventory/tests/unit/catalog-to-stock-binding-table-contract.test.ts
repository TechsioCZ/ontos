import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import {
  inventoryCatalogToStockBindingHistory,
  inventoryCatalogToStockBindings,
} from '../../src/persistence/catalog-to-stock-binding-table.ts';

it('persists one Current binding per exact Selection and per Stock Item target', () => {
  const config = getTableConfig(inventoryCatalogToStockBindings);

  expect(`${config.schema}.${config.name}`).toBe('inventory.catalog_to_stock_bindings');
  expect(config.enableRLS).toBe(true);
  expect(config.columns.map((column) => column.name)).toEqual([
    'binding_id',
    'tenant_id',
    'catalog_selection',
    'exact_selection_meaning_id',
    'exact_selection_kind',
    'stock_item_id',
    'stock_unit_module_id',
    'stock_unit_resource_id',
    'stock_unit_resource_type',
    'stock_unit_tenant_id',
    'current_revision',
    'effective_from',
  ]);
  expect(config.indexes.map((index) => index.config.name)).toEqual(
    expect.arrayContaining([
      'inventory_catalog_to_stock_bindings_selection_meaning_uk',
      'inventory_catalog_to_stock_bindings_stock_item_uk',
    ]),
  );
  expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
});

it('keeps corrected relation snapshots in an append-only tenant-scoped history', () => {
  const config = getTableConfig(inventoryCatalogToStockBindingHistory);

  expect(`${config.schema}.${config.name}`).toBe('inventory.catalog_to_stock_binding_history');
  expect(config.enableRLS).toBe(true);
  expect(config.columns.map((column) => column.name)).toEqual([
    'binding_history_id',
    'tenant_id',
    'binding_id',
    'revision',
    'snapshot',
    'ended_at',
    'transition',
    'owner_evidence_ref',
    'recorded_at',
  ]);
  expect(config.indexes.map((index) => index.config.name)).toContain(
    'inventory_catalog_to_stock_binding_history_revision_uk',
  );
  expect(config.foreignKeys).toHaveLength(0);
});
