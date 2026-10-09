/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryObligationRequirements } from './inventory-obligation-table.ts';
import { inventoryStockItems } from './stock-item-table.ts';

export const inventoryBindingCorrectionReconciliations = inventorySchema.table.withRLS(
  'binding_correction_reconciliations',
  {
    reconciliationId: uuid('reconciliation_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    bindingId: uuid('binding_id').notNull(),
    bindingRevision: integer('binding_revision').notNull(),
    correctionEvidenceRef: text('correction_evidence_ref').notNull(),
    correctedAt: timestamp('corrected_at', { withTimezone: true }).notNull(),
    obligationId: uuid('obligation_id').notNull(),
    purchaseDemandOccurrenceId: text('purchase_demand_occurrence_id').notNull(),
    historicalStockItemId: uuid('historical_stock_item_id').notNull(),
    currentStockItemId: uuid('current_stock_item_id').notNull(),
    reason: text('reason').default('POST_COMMIT_BINDING_MISMATCH').notNull(),
    status: text('status').default('OPEN').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_binding_correction_reconciliations_scope_id_uk').on(table.tenantId, table.reconciliationId),
    uniqueIndex('inventory_binding_correction_reconciliations_observation_uk').on(
      table.tenantId,
      table.bindingId,
      table.bindingRevision,
      table.obligationId,
      table.purchaseDemandOccurrenceId,
    ),
    index('inventory_binding_correction_reconciliations_open_idx').on(table.tenantId, table.status, table.correctedAt),
    foreignKey({
      columns: [table.tenantId, table.obligationId, table.purchaseDemandOccurrenceId],
      foreignColumns: [
        inventoryObligationRequirements.tenantId,
        inventoryObligationRequirements.obligationId,
        inventoryObligationRequirements.purchaseDemandOccurrenceId,
      ],
      name: 'inventory_binding_correction_reconciliations_requirement_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.historicalStockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_binding_correction_reconciliations_historical_item_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.currentStockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_binding_correction_reconciliations_current_item_fk',
    }).onDelete('restrict'),
    check(
      'inventory_binding_correction_reconciliations_meaning_ck',
      sql`${table.bindingRevision} >= 2 and char_length(btrim(${table.correctionEvidenceRef})) between 1 and 300 and char_length(btrim(${table.purchaseDemandOccurrenceId})) between 1 and 300 and ${table.reason} = 'POST_COMMIT_BINDING_MISMATCH' and ${table.status} = 'OPEN' and ${table.historicalStockItemId} <> ${table.currentStockItemId}`,
    ),
    ...tenantRlsPolicies('inventory_binding_correction_reconciliations_tenant', table.tenantId),
  ],
);
