import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import {
  inventoryCatalogToStockBindingHistory,
  inventoryCatalogToStockBindingHistoryImmutabilityContract,
  inventoryCatalogToStockBindingCompatibilityTriggerContract,
  inventoryCatalogToStockBindingMeaningKeyContract,
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

it('keys Current uniqueness by owner-issued exact meaning while retaining full Selection provenance', () => {
  expect(inventoryCatalogToStockBindingMeaningKeyContract).toEqual({
    columns: ['tenant_id', 'exact_selection_meaning_id'],
    evidenceOnlyPath: 'catalog_selection.configuration.definition.revision',
    indexName: 'inventory_catalog_to_stock_bindings_selection_meaning_uk',
    provenanceColumn: 'catalog_selection',
  });
});

it('publishes exact database hardening for compatible Current Stock Item targets', () => {
  expect(inventoryCatalogToStockBindingCompatibilityTriggerContract).toEqual({
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
  });
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
  expect(inventoryCatalogToStockBindingHistoryImmutabilityContract).toEqual({
    currentRetention: 'CURRENT_ROW_REMOVED_AFTER_ARCHIVE',
    deleteTriggerName: 'inventory_catalog_to_stock_binding_history_no_delete_trg',
    functionName: 'inventory.reject_catalog_to_stock_binding_history_mutation',
    table: 'inventory.catalog_to_stock_binding_history',
    updateTriggerName: 'inventory_catalog_to_stock_binding_history_no_update_trg',
  });
});
