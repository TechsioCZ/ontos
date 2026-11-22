/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type {
  ProvisionSourceStockItemInput,
  SourceStockItemProvisioning,
} from '../../shared/domain/source-provisioning.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryStockItems } from './stock-item-table.ts';
import { inventoryStockLocations } from './stock-location-table.ts';

/** One immutable provisioning rule per external Inventory Backend configuration. */
export const inventorySourceProvisioningPolicies = inventorySchema.table.withRLS(
  'source_provisioning_policies',
  {
    policyId: uuid('policy_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    ownerConfigurationId: uuid('owner_configuration_id').notNull(),
    issuerBackendKind: text('issuer_backend_kind').notNull(),
    issuerBackendId: text('issuer_backend_id').notNull(),
    namespace: text('namespace').notNull(),
    externalScope: text('external_scope').notNull(),
    unitResourceId: uuid('unit_resource_id').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    definedAt: timestamp('defined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_source_provisioning_policies_scope_id_uk').on(table.tenantId, table.policyId),
    uniqueIndex('inventory_source_provisioning_policies_owner_uk').on(table.tenantId, table.ownerConfigurationId),
    uniqueIndex('inventory_source_provisioning_policies_qualification_uk').on(
      table.tenantId,
      table.customerConfigurationId,
      table.issuerBackendKind,
      table.issuerBackendId,
      table.namespace,
      table.externalScope,
    ),
    foreignKey({
      columns: [table.tenantId, table.ownerConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_source_provisioning_policies_owner_fk',
    }).onDelete('restrict'),
    check(
      'inventory_source_provisioning_policies_text_ck',
      sql`length(btrim(${table.customerConfigurationId})) between 1 and 300 and ${table.issuerBackendKind} = 'external_business_system' and length(btrim(${table.issuerBackendId})) between 1 and 300 and length(btrim(${table.namespace})) between 1 and 300 and length(btrim(${table.externalScope})) between 1 and 300`,
    ),
    ...tenantRlsPolicies('inventory_source_provisioning_policies_tenant', table.tenantId),
  ],
);

/** The Stock Locations a policy provisions into, each with the ERP's own location key. */
export const inventorySourceProvisioningPolicyLocations = inventorySchema.table.withRLS(
  'source_provisioning_policy_locations',
  {
    tenantId: uuid('tenant_id').notNull(),
    policyId: uuid('policy_id').notNull(),
    locationKey: text('location_key').notNull(),
    stockLocationId: uuid('stock_location_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.policyId, table.locationKey],
      name: 'inventory_source_provisioning_policy_locations_pk',
    }),
    uniqueIndex('inventory_source_provisioning_policy_locations_location_uk').on(
      table.tenantId,
      table.policyId,
      table.stockLocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.policyId],
      foreignColumns: [inventorySourceProvisioningPolicies.tenantId, inventorySourceProvisioningPolicies.policyId],
      name: 'inventory_source_provisioning_policy_locations_policy_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockLocationId],
      foreignColumns: [inventoryStockLocations.tenantId, inventoryStockLocations.stockLocationId],
      name: 'inventory_source_provisioning_policy_locations_location_fk',
    }).onDelete('restrict'),
    check(
      'inventory_source_provisioning_policy_locations_key_ck',
      sql`length(btrim(${table.locationKey})) between 1 and 300`,
    ),
    ...tenantRlsPolicies('inventory_source_provisioning_policy_locations_tenant', table.tenantId),
  ],
);

/** The receipt of one committed provisioning invocation, read back after a lost response. */
export const inventorySourceStockItemProvisionings = inventorySchema.table.withRLS(
  'source_stock_item_provisionings',
  {
    tenantId: uuid('tenant_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    policyId: uuid('policy_id').notNull(),
    itemKey: text('item_key').notNull(),
    stockItemId: uuid('stock_item_id').notNull(),
    inputJson: jsonb('input_json').$type<ProvisionSourceStockItemInput>().notNull(),
    provisioningJson: jsonb('provisioning_json').$type<SourceStockItemProvisioning>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.actionInvocationId],
      name: 'inventory_source_stock_item_provisionings_pk',
    }),
    index('inventory_source_stock_item_provisionings_item_idx').on(table.tenantId, table.policyId, table.itemKey),
    foreignKey({
      columns: [table.tenantId, table.policyId],
      foreignColumns: [inventorySourceProvisioningPolicies.tenantId, inventorySourceProvisioningPolicies.policyId],
      name: 'inventory_source_stock_item_provisionings_policy_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_source_stock_item_provisionings_item_fk',
    }).onDelete('restrict'),
    check('inventory_source_stock_item_provisionings_key_ck', sql`length(btrim(${table.itemKey})) between 1 and 300`),
    ...tenantRlsPolicies('inventory_source_stock_item_provisionings_tenant', table.tenantId),
  ],
);

export const inventorySourceProvisioningDatabaseContract = {
  immutableFunction: 'inventory.reject_source_provisioning_mutation()',
  scopeFunction: 'inventory.enforce_source_provisioning_scope()',
  tables: ['source_provisioning_policies', 'source_provisioning_policy_locations', 'source_stock_item_provisionings'],
  triggers: [
    'inventory_source_provisioning_policies_scope_trg',
    'inventory_source_provisioning_policies_no_mutation_trg',
    'inventory_source_provisioning_policy_locations_scope_trg',
    'inventory_source_provisioning_policy_locations_no_mutation_trg',
    'inventory_source_stock_item_provisionings_scope_trg',
    'inventory_source_stock_item_provisionings_no_mutation_trg',
  ],
} as const;
