/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { StockCorrectionRecord } from '../../shared/domain/stock-correction.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventorySourceAssertions } from './inventory-source-assertion-table.ts';
import { inventoryStockCorrectionSourceEvidence } from './stock-correction-source-evidence-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

const STOCK_CORRECTIONS_TABLE = 'inventory.stock_corrections';
const STOCK_CORRECTION_OPEN_RECONCILIATIONS_TABLE = 'inventory.stock_correction_open_reconciliations';

/**
 * Migration-owned verifier for the append-only correction evidence. It must exact-match the JSON
 * record to the relational identity, evidence branch, Position, selected authority, absolute
 * quantity, and optimistic revision columns before accepting an insert. External evidence must
 * bind a Source Assertion; direct OntOS WMS owner evidence must not synthesize one.
 */
export const inventoryStockCorrectionExactScopeVerifierContract = {
  constraintName: 'inventory_stock_corrections_exact_scope_ck',
  event: 'INSERT',
  functionName: 'inventory.enforce_stock_correction_exact_scope',
  table: STOCK_CORRECTIONS_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_stock_corrections_exact_scope_trg',
} as const;

/** Correction evidence is append-only. Reconciliation changes only the separate open marker. */
export const inventoryStockCorrectionImmutabilityContract = {
  columns: [
    'correction_id',
    'tenant_id',
    'action_invocation_id',
    'principal_id',
    'customer_configuration_id',
    'position_id',
    'source_assertion_id',
    'source_evidence_id',
    'authority_configuration_id',
    'evidence_kind',
    'issuer_backend_kind',
    'issuer_backend_id',
    'owner_evidence_ref',
    'source_reference',
    'business_observed_at',
    'expected_position_revision',
    'position_revision_after',
    'state',
    'corrected_quantity_amount',
    'reconciles_correction_id',
    'coverage_evidence_json',
    'evaluated_material_effect_ids_json',
    'record_json',
    'applied_at',
  ],
  comparison: 'IS DISTINCT FROM',
  errorCondition: 'check_violation',
  event: 'UPDATE OR DELETE',
  functionName: 'inventory.reject_stock_correction_mutation',
  table: STOCK_CORRECTIONS_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_stock_corrections_immutable_trg',
} as const;

/**
 * The marker transition verifier permits only an exact reconciliation chain for one Position:
 * insert an INDETERMINATE head, replace it with an INDETERMINATE correction that reconciles the
 * old head, or delete it after a correction that reconciles the old head becomes APPLIED.
 */
export const inventoryStockCorrectionOpenTransitionContract = {
  constraintName: 'inventory_stock_correction_open_transition_ck',
  event: 'INSERT OR UPDATE OR DELETE',
  functionName: 'inventory.enforce_stock_correction_open_transition',
  table: STOCK_CORRECTION_OPEN_RECONCILIATIONS_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_stock_correction_open_transition_trg',
} as const;

export const inventoryStockCorrections = inventorySchema.table.withRLS(
  'stock_corrections',
  {
    correctionId: uuid('correction_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    actionInvocationId: uuid('action_invocation_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    positionId: uuid('position_id').notNull(),
    sourceAssertionId: uuid('source_assertion_id'),
    sourceEvidenceId: uuid('source_evidence_id'),
    authorityConfigurationId: uuid('authority_configuration_id').notNull(),
    evidenceKind: text('evidence_kind').notNull(),
    issuerBackendKind: text('issuer_backend_kind').notNull(),
    issuerBackendId: text('issuer_backend_id').notNull(),
    ownerEvidenceRef: text('owner_evidence_ref').notNull(),
    sourceReference: text('source_reference').notNull(),
    businessObservedAt: timestamp('business_observed_at', { withTimezone: true }).notNull(),
    expectedPositionRevision: integer('expected_position_revision').notNull(),
    positionRevisionAfter: integer('position_revision_after').notNull(),
    state: text('state').notNull(),
    correctedQuantityAmount: numeric('corrected_quantity_amount', { precision: 38, scale: 9 }),
    reconcilesCorrectionId: uuid('reconciles_correction_id'),
    coverageEvidenceJson: jsonb('coverage_evidence_json').$type<StockCorrectionRecord['coverageEvidence']>().notNull(),
    evaluatedMaterialEffectIdsJson: jsonb('evaluated_material_effect_ids_json')
      .$type<StockCorrectionRecord['evaluatedMaterialEffectIds']>()
      .notNull(),
    recordJson: jsonb('record_json').$type<StockCorrectionRecord>().notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_stock_corrections_tenant_id_uk').on(table.tenantId, table.correctionId),
    uniqueIndex('inventory_stock_corrections_assertion_uk')
      .on(table.tenantId, table.sourceAssertionId)
      .where(sql`${table.sourceAssertionId} is not null`),
    uniqueIndex('inventory_stock_corrections_source_evidence_uk')
      .on(table.tenantId, table.sourceEvidenceId)
      .where(sql`${table.sourceEvidenceId} is not null`),
    uniqueIndex('inventory_stock_corrections_reconciles_uk')
      .on(table.tenantId, table.reconcilesCorrectionId)
      .where(sql`${table.reconcilesCorrectionId} is not null`),
    index('inventory_stock_corrections_position_idx').on(table.tenantId, table.positionId, table.appliedAt),
    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_stock_corrections_position_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.sourceAssertionId],
      foreignColumns: [inventorySourceAssertions.tenantId, inventorySourceAssertions.assertionId],
      name: 'inventory_stock_corrections_assertion_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.sourceEvidenceId],
      foreignColumns: [
        inventoryStockCorrectionSourceEvidence.tenantId,
        inventoryStockCorrectionSourceEvidence.evidenceId,
      ],
      name: 'inventory_stock_corrections_source_evidence_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.authorityConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_stock_corrections_authority_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.reconcilesCorrectionId],
      foreignColumns: [table.tenantId, table.correctionId],
      name: 'inventory_stock_corrections_reconciles_fk',
    }).onDelete('restrict'),
    check(
      'inventory_stock_corrections_customer_configuration_ck',
      sql`${table.customerConfigurationId} = btrim(${table.customerConfigurationId}) and length(${table.customerConfigurationId}) between 1 and 300`,
    ),
    check(
      'inventory_stock_corrections_provenance_text_ck',
      sql`length(btrim(${table.issuerBackendId})) between 1 and 300 and length(btrim(${table.ownerEvidenceRef})) between 1 and 300 and length(btrim(${table.sourceReference})) between 1 and 300`,
    ),
    check(
      'inventory_stock_corrections_issuer_ck',
      sql`${table.issuerBackendKind} in ('external_business_system', 'ontos_wms')`,
    ),
    check(
      'inventory_stock_corrections_evidence_ck',
      sql`(${table.evidenceKind} = 'EXTERNAL_SOURCE_ASSERTION' and ${table.issuerBackendKind} = 'external_business_system' and ${table.sourceAssertionId} is not null and ${table.sourceEvidenceId} is null) or (${table.evidenceKind} = 'ONTOS_WMS_OWNER_EVIDENCE' and ${table.issuerBackendKind} = 'ontos_wms' and ${table.sourceAssertionId} is null and ${table.sourceEvidenceId} is not null)`,
    ),
    check('inventory_stock_corrections_state_ck', sql`${table.state} in ('APPLIED', 'INDETERMINATE')`),
    check(
      'inventory_stock_corrections_quantity_ck',
      sql`(${table.state} = 'APPLIED' and ${table.correctedQuantityAmount} is not null and ${table.correctedQuantityAmount} >= 0) or (${table.state} = 'INDETERMINATE' and ${table.correctedQuantityAmount} is null)`,
    ),
    check(
      'inventory_stock_corrections_revision_ck',
      sql`${table.expectedPositionRevision} >= 1 and ${table.positionRevisionAfter} = ${table.expectedPositionRevision} + 1 and ${table.positionRevisionAfter} <= 2147483647`,
    ),
    ...tenantRlsPolicies('inventory_stock_corrections_tenant', table.tenantId),
  ],
);

/** One row per Position means an indeterminate outcome must be reconciled before a fresh mutation. */
export const inventoryStockCorrectionOpenReconciliations = inventorySchema.table.withRLS(
  'stock_correction_open_reconciliations',
  {
    tenantId: uuid('tenant_id').notNull(),
    positionId: uuid('position_id').notNull(),
    correctionId: uuid('correction_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.positionId],
      name: 'inventory_stock_correction_open_pk',
    }),
    uniqueIndex('inventory_stock_correction_open_correction_uk').on(table.tenantId, table.correctionId),
    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_stock_correction_open_position_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.correctionId],
      foreignColumns: [inventoryStockCorrections.tenantId, inventoryStockCorrections.correctionId],
      name: 'inventory_stock_correction_open_correction_fk',
    }).onDelete('restrict'),
    ...tenantRlsPolicies('inventory_stock_correction_open_tenant', table.tenantId),
  ],
);
