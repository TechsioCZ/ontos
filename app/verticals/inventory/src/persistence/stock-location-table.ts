/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import type { StockLocation, StockLocationAddressEvidence } from '../../shared/domain/stock-location.ts';
import { inventorySchema } from '../database/inventory-schema.ts';

/**
 * Current owner row. Terminal locations remain addressable and point forward instead of being
 * deleted or having their identity rewritten.
 */
export const inventoryStockLocations = inventorySchema.table.withRLS(
  'stock_locations',
  {
    stockLocationId: uuid('stock_location_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    displayName: text('display_name').notNull(),
    scopeKind: text('scope_kind').notNull(),
    physicalSiteKeys: jsonb('physical_site_keys').$type<readonly string[]>().notNull(),
    addressEvidence: jsonb('address_evidence').$type<StockLocationAddressEvidence>(),
    lifecycleState: text('lifecycle_state').notNull(),
    successorStockLocationId: uuid('successor_stock_location_id'),
    transitionReason: text('transition_reason'),
    transitionedAt: timestamp('transitioned_at', { withTimezone: true }),
    currentRevision: integer('current_revision').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('inventory_stock_locations_scope_id_uk').on(table.tenantId, table.stockLocationId),
    foreignKey({
      columns: [table.tenantId, table.successorStockLocationId],
      foreignColumns: [table.tenantId, table.stockLocationId],
      name: 'inventory_stock_locations_successor_fk',
    }).onDelete('restrict'),
    index('inventory_stock_locations_lifecycle_idx').on(table.tenantId, table.lifecycleState),
    check('inventory_stock_locations_revision_ck', sql`${table.currentRevision} >= 1`),
    check(
      'inventory_stock_locations_display_name_ck',
      sql`${table.displayName} = btrim(${table.displayName}) and length(${table.displayName}) between 1 and 300`,
    ),
    check('inventory_stock_locations_scope_kind_ck', sql`${table.scopeKind} in ('PHYSICAL_SITE', 'LOGICAL_AGGREGATE')`),
    check(
      'inventory_stock_locations_site_keys_ck',
      sql`jsonb_typeof(${table.physicalSiteKeys}) = 'array' and jsonb_array_length(${table.physicalSiteKeys}) <= 100 and (${table.scopeKind} <> 'PHYSICAL_SITE' or jsonb_array_length(${table.physicalSiteKeys}) = 1)`,
    ),
    check(
      'inventory_stock_locations_lifecycle_ck',
      sql`${table.lifecycleState} in ('ACTIVE', 'RETIRED', 'REPLACED', 'MERGED')`,
    ),
    check(
      'inventory_stock_locations_successor_ck',
      sql`((${table.lifecycleState} in ('ACTIVE', 'RETIRED')) and ${table.successorStockLocationId} is null) or ((${table.lifecycleState} in ('REPLACED', 'MERGED')) and ${table.successorStockLocationId} is not null and ${table.successorStockLocationId} <> ${table.stockLocationId})`,
    ),
    check(
      'inventory_stock_locations_transition_ck',
      sql`(${table.lifecycleState} = 'ACTIVE' and ${table.transitionReason} is null and ${table.transitionedAt} is null) or (${table.lifecycleState} <> 'ACTIVE' and ${table.transitionReason} = btrim(${table.transitionReason}) and length(${table.transitionReason}) between 1 and 1000 and ${table.transitionedAt} is not null)`,
    ),
    ...tenantRlsPolicies('inventory_stock_locations_tenant', table.tenantId),
  ],
);

/** Exact append-only snapshots used to reconstruct the meaning referenced by historical facts. */
export const inventoryStockLocationRevisions = inventorySchema.table.withRLS(
  'stock_location_revisions',
  {
    stockLocationRevisionId: uuid('stock_location_revision_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    stockLocationId: uuid('stock_location_id').notNull(),
    revision: integer('revision').notNull(),
    snapshot: jsonb('snapshot').$type<StockLocation>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('inventory_stock_location_revisions_scope_id_uk').on(table.tenantId, table.stockLocationRevisionId),
    unique('inventory_stock_location_revisions_number_uk').on(table.tenantId, table.stockLocationId, table.revision),
    foreignKey({
      columns: [table.tenantId, table.stockLocationId],
      foreignColumns: [inventoryStockLocations.tenantId, inventoryStockLocations.stockLocationId],
      name: 'inventory_stock_location_revisions_location_fk',
    }).onDelete('restrict'),
    check('inventory_stock_location_revisions_revision_ck', sql`${table.revision} >= 1`),
    ...tenantRlsPolicies('inventory_stock_location_revisions_tenant', table.tenantId),
  ],
);

export const INVENTORY_STOCK_LOCATION_TABLES = [inventoryStockLocationRevisions, inventoryStockLocations] as const;
