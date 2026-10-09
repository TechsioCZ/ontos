/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { InventorySourceImportOutcome } from '../../shared/domain/inventory-source-import-outcome.ts';
import type { InventorySourceAssertionProposal } from '../../shared/domain/inventory-source-assertion.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

export const inventorySourceImportLedger = inventorySchema.table.withRLS(
  'source_import_ledger',
  {
    tenantId: uuid('tenant_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    itemIndex: integer('item_index').notNull(),
    assertionId: uuid('assertion_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    issuerBackendKind: text('issuer_backend_kind').notNull(),
    issuerBackendId: text('issuer_backend_id').notNull(),
    factMeaning: text('fact_meaning').notNull(),
    positionId: uuid('position_id').notNull(),
    sourceReference: text('source_reference').notNull(),
    orderingEvidenceKind: text('ordering_evidence_kind').notNull(),
    orderingEvidenceValue: text('ordering_evidence_value').notNull(),
    status: text('status').notNull(),
    proposalJson: jsonb('proposal_json').$type<InventorySourceAssertionProposal>().notNull(),
    outcomeJson: jsonb('outcome_json').$type<InventorySourceImportOutcome>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.actionInvocationId, table.itemIndex],
      name: 'inventory_source_import_ledger_pk',
    }),
    index('inventory_source_import_ledger_stream_idx').on(
      table.tenantId,
      table.customerConfigurationId,
      table.issuerBackendKind,
      table.issuerBackendId,
      table.factMeaning,
      table.positionId,
      table.recordedAt,
    ),
    uniqueIndex('inventory_source_import_accepted_assertion_uk')
      .on(table.tenantId, table.assertionId)
      .where(sql`${table.status} = 'ACCEPTED'`),
    uniqueIndex('inventory_source_import_accepted_source_identity_uk')
      .on(
        table.tenantId,
        table.customerConfigurationId,
        table.issuerBackendKind,
        table.issuerBackendId,
        table.factMeaning,
        table.positionId,
        table.sourceReference,
      )
      .where(sql`${table.status} = 'ACCEPTED'`),
    uniqueIndex('inventory_source_import_accepted_revision_uk')
      .on(
        table.tenantId,
        table.customerConfigurationId,
        table.issuerBackendKind,
        table.issuerBackendId,
        table.factMeaning,
        table.positionId,
        table.orderingEvidenceKind,
        table.orderingEvidenceValue,
      )
      .where(sql`${table.status} = 'ACCEPTED'`),
    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_source_import_ledger_position_fk',
    }).onDelete('restrict'),
    check('inventory_source_import_ledger_item_index_ck', sql`${table.itemIndex} >= 0`),
    check(
      'inventory_source_import_ledger_meaning_ck',
      sql`${table.factMeaning} = 'ABSOLUTE_PHYSICAL_ON_HAND' and ${table.issuerBackendKind} = 'external_business_system'`,
    ),
    check(
      'inventory_source_import_ledger_ordering_ck',
      sql`${table.orderingEvidenceKind} in ('SOURCE_REVISION', 'OWNER_ORDER_KEY')`,
    ),
    check(
      'inventory_source_import_ledger_status_ck',
      sql`${table.status} in ('ACCEPTED', 'DUPLICATE', 'STALE', 'REJECTED', 'INDETERMINATE')`,
    ),
    check(
      'inventory_source_import_ledger_text_ck',
      sql`length(btrim(${table.customerConfigurationId})) between 1 and 300 and length(btrim(${table.issuerBackendId})) between 1 and 300 and length(btrim(${table.sourceReference})) between 1 and 300 and length(btrim(${table.orderingEvidenceValue})) between 1 and 300`,
    ),
    ...tenantRlsPolicies('inventory_source_import_ledger_tenant', table.tenantId),
  ],
);

/** The migration enforces immutable evidence and exact JSON/column scope, including accepted assertion existence. */
export const inventorySourceImportLedgerVerifierContract = {
  acceptedAssertionForeignKey: 'inventory_source_import_ledger_accepted_assertion_fk',
  functionName: 'inventory.enforce_source_import_ledger_exact_scope',
  immutableTriggerName: 'inventory_source_import_ledger_immutable_trg',
  scopeTriggerName: 'inventory_source_import_ledger_exact_scope_trg',
  table: 'inventory.source_import_ledger',
} as const;
