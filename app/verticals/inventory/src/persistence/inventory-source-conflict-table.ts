/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import type { InventorySourceConflict } from '../../shared/domain/inventory-source-conflict.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

const INVENTORY_SOURCE_CONFLICT_REVISIONS_TABLE = 'inventory.source_conflict_revisions';

/** Every lifecycle transition is a new immutable revision; resolution never rewrites source evidence. */
export const inventorySourceConflictRevisionContract = {
  errorCondition: 'check_violation',
  event: 'INSERT OR UPDATE OR DELETE',
  functionName: 'inventory.enforce_source_conflict_revision',
  immutableTriggerName: 'inventory_source_conflict_revisions_immutable_trg',
  sequenceTriggerName: 'inventory_source_conflict_revisions_sequence_trg',
  table: INVENTORY_SOURCE_CONFLICT_REVISIONS_TABLE,
  timing: 'BEFORE',
} as const;

/** Migration verification rechecks the complete JSON evidence against these relational scope columns. */
export const inventorySourceConflictScopeVerifierContract = {
  event: 'INSERT',
  functionName: 'inventory.enforce_source_conflict_exact_scope',
  table: INVENTORY_SOURCE_CONFLICT_REVISIONS_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_source_conflict_revisions_exact_scope_trg',
} as const;

export const inventorySourceConflictRevisions = inventorySchema.table.withRLS(
  'source_conflict_revisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    conflictId: uuid('conflict_id').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    conflictType: text('conflict_type').notNull(),
    currentTruth: text('current_truth').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    positionId: uuid('position_id'),
    factMeaning: text('fact_meaning'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    conflictJson: jsonb('conflict_json').$type<InventorySourceConflict>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.conflictId, table.revision],
      name: 'inventory_source_conflict_revisions_pk',
    }),
    index('inventory_source_conflict_latest_idx').on(table.tenantId, table.conflictId, table.revision),
    index('inventory_source_conflict_position_idx').on(table.tenantId, table.positionId, table.status),
    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_source_conflict_revisions_position_fk',
    }).onDelete('restrict'),
    check('inventory_source_conflict_revision_ck', sql`${table.revision} in (1, 2)`),
    check(
      'inventory_source_conflict_status_ck',
      sql`(${table.revision} = 1 and ${table.status} = 'OPEN' and ${table.currentTruth} = 'INDETERMINATE' and ${table.resolvedAt} is null) or (${table.revision} = 2 and ${table.status} = 'RESOLVED' and ${table.currentTruth} in ('CURRENT', 'CONFIGURATION_SINGULAR') and ${table.resolvedAt} is not null and ${table.resolvedAt} >= ${table.detectedAt})`,
    ),
    check(
      'inventory_source_conflict_type_ck',
      sql`${table.conflictType} in ('CORRELATION', 'FACT_VALUE', 'BACKEND_CONFIGURATION', 'ASSERTION_INTEGRITY')`,
    ),
    check(
      'inventory_source_conflict_scope_ck',
      sql`(${table.conflictType} in ('BACKEND_CONFIGURATION', 'CORRELATION') and ${table.positionId} is null and ${table.factMeaning} is null) or (${table.conflictType} in ('FACT_VALUE', 'ASSERTION_INTEGRITY') and ${table.positionId} is not null and ${table.factMeaning} = 'ABSOLUTE_PHYSICAL_ON_HAND')`,
    ),
    check(
      'inventory_source_conflict_customer_configuration_ck',
      sql`${table.customerConfigurationId} = btrim(${table.customerConfigurationId}) and length(${table.customerConfigurationId}) between 1 and 300`,
    ),
    ...tenantRlsPolicies('inventory_source_conflict_revisions_tenant', table.tenantId),
  ],
);

/* oxlint-enable perfectionist/sort-objects */
