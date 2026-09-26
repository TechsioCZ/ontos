/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, numeric, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryStockItems } from './stock-item-table.ts';
import { inventoryStockLocations } from './stock-location-table.ts';

const STOCK_POSITIONS_TABLE = 'inventory.stock_positions';

export const inventoryStockPositionImmutabilityTriggerContract = {
  columns: [
    'stock_position_id',
    'tenant_id',
    'customer_configuration_id',
    'stock_item_id',
    'stock_location_id',
    'stock_unit_module_id',
    'stock_unit_resource_id',
    'stock_unit_resource_type',
    'stock_unit_tenant_id',
  ],
  comparison: 'IS DISTINCT FROM',
  errorCondition: 'check_violation',
  event: 'UPDATE OR DELETE',
  functionName: 'inventory.reject_stock_position_scope_mutation',
  table: STOCK_POSITIONS_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_stock_positions_immutable_scope_trg',
} as const;

/** Migration hardening for the exact Product Unit already fixed by the referenced Stock Item. */
export const inventoryStockPositionUnitMatchTriggerContract = {
  constraintName: 'inventory_stock_positions_exact_item_unit_ck',
  errorCondition: 'check_violation',
  event: 'INSERT OR UPDATE',
  functionName: 'inventory.enforce_stock_position_stock_item_unit',
  lookupColumns: [
    'tenant_id',
    'stock_item_id',
    'stock_unit_module_id',
    'stock_unit_resource_id',
    'stock_unit_resource_type',
    'stock_unit_tenant_id',
  ],
  lookupTable: 'inventory.stock_items',
  table: STOCK_POSITIONS_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_stock_positions_exact_item_unit_trg',
} as const;

/** Migration hardening for the selected Customer Configuration-wide Inventory Backend owner. */
export const inventoryStockPositionOwnerConfigurationTriggerContract = {
  constraintName: 'inventory_stock_positions_owner_configuration_ck',
  event: 'INSERT OR UPDATE',
  foreignKeyName: 'inventory_stock_positions_backend_configuration_fk',
  functionName: 'inventory.enforce_stock_position_owner_configuration',
  lookupColumns: ['tenant_id', 'configuration_id', 'customer_configuration_id'],
  lookupTable: 'inventory.backend_configurations',
  table: STOCK_POSITIONS_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_stock_positions_owner_configuration_trg',
} as const;

/**
 * Durable Position rows retain historical identities. RESERVED deliberately has no column: it is
 * derived from Current successful Reservation Allocations at the owner read seam.
 */
export const inventoryStockPositions = inventorySchema.table.withRLS(
  'stock_positions',
  {
    stockPositionId: uuid('stock_position_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    stockItemId: uuid('stock_item_id').notNull(),
    stockLocationId: uuid('stock_location_id').notNull(),
    stockUnitModuleId: text('stock_unit_module_id').notNull(),
    stockUnitResourceId: uuid('stock_unit_resource_id').notNull(),
    stockUnitResourceType: text('stock_unit_resource_type').notNull(),
    stockUnitTenantId: uuid('stock_unit_tenant_id').notNull(),
    lifecycleState: text('lifecycle_state').default('CURRENT').notNull(),
    onHandState: text('on_hand_state').notNull(),
    onHandAmount: numeric('on_hand_amount', { precision: 38, scale: 9 }),
    onHandEvidenceRef: text('on_hand_evidence_ref'),
    onHandObservedAt: timestamp('on_hand_observed_at', { withTimezone: true }),
    ownerConfigurationId: uuid('owner_configuration_id').notNull(),
    revision: integer('revision').default(1).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_stock_positions_scope_id_uk').on(table.tenantId, table.stockPositionId),
    uniqueIndex('inventory_stock_positions_current_scope_uk')
      .on(table.tenantId, table.customerConfigurationId, table.stockItemId, table.stockLocationId)
      .where(sql`${table.lifecycleState} = 'CURRENT'`),
    foreignKey({
      columns: [table.tenantId, table.stockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_stock_positions_item_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockLocationId],
      foreignColumns: [inventoryStockLocations.tenantId, inventoryStockLocations.stockLocationId],
      name: 'inventory_stock_positions_location_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.ownerConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_stock_positions_backend_configuration_fk',
    }).onDelete('restrict'),
    index('inventory_stock_positions_item_idx').on(table.tenantId, table.stockItemId),
    index('inventory_stock_positions_location_idx').on(table.tenantId, table.stockLocationId),
    check(
      'inventory_stock_positions_customer_configuration_ck',
      sql`${table.customerConfigurationId} = btrim(${table.customerConfigurationId}) and length(${table.customerConfigurationId}) between 1 and 300`,
    ),
    check(
      'inventory_stock_positions_unit_ck',
      sql`${table.stockUnitModuleId} = 'commerce.catalog' and ${table.stockUnitResourceType} = 'commerce.catalog.product-unit' and ${table.stockUnitTenantId} = ${table.tenantId}`,
    ),
    check('inventory_stock_positions_lifecycle_ck', sql`${table.lifecycleState} in ('CURRENT', 'HISTORICAL')`),
    check(
      'inventory_stock_positions_ended_at_ck',
      sql`(${table.lifecycleState} = 'CURRENT' and ${table.endedAt} is null) or (${table.lifecycleState} = 'HISTORICAL' and ${table.endedAt} is not null)`,
    ),
    check(
      'inventory_stock_positions_historical_on_hand_ck',
      sql`not (${table.lifecycleState} = 'HISTORICAL' and ${table.onHandState} = 'CURRENT')`,
    ),
    check(
      'inventory_stock_positions_on_hand_state_ck',
      sql`${table.onHandState} in ('CURRENT', 'UNKNOWN', 'MISSING', 'STALE', 'INDETERMINATE')`,
    ),
    check(
      'inventory_stock_positions_on_hand_value_ck',
      sql`((${table.onHandState} in ('CURRENT', 'STALE')) and ${table.onHandAmount} is not null and ${table.onHandAmount} >= 0 and ${table.onHandEvidenceRef} is not null and ${table.onHandObservedAt} is not null) or ((${table.onHandState} in ('UNKNOWN', 'MISSING', 'INDETERMINATE')) and ${table.onHandAmount} is null and ${table.onHandEvidenceRef} is null and ${table.onHandObservedAt} is null)`,
    ),
    check('inventory_stock_positions_revision_ck', sql`${table.revision} >= 1`),
    ...tenantRlsPolicies('inventory_stock_positions_tenant', table.tenantId),
  ],
);

export const INVENTORY_STOCK_POSITION_TABLES = [inventoryStockPositions] as const;
