/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { OntosWmsStockCorrectionSourceEvidence } from '../../shared/domain/stock-correction.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryPhysicalStockEffects } from './physical-stock-effect-table.ts';
import { inventoryStockItems } from './stock-item-table.ts';
import { inventoryStockLocations } from './stock-location-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

const SOURCE_EVIDENCE_TABLE = 'inventory.stock_correction_source_evidence';
const SOURCE_EVIDENCE_COVERAGE_TABLE = 'inventory.stock_correction_source_evidence_coverage';
const SOURCE_EVIDENCE_CURRENT_TABLE = 'inventory.stock_correction_source_evidence_current';

/** Evidence and its coverage are immutable; only the exact current-head pointer may advance. */
export const inventoryStockCorrectionSourceEvidenceImmutabilityContract = {
  comparison: 'IS DISTINCT FROM',
  errorCondition: 'check_violation',
  event: 'UPDATE OR DELETE',
  functionName: 'inventory.reject_stock_correction_source_evidence_mutation',
  tables: [SOURCE_EVIDENCE_TABLE, SOURCE_EVIDENCE_COVERAGE_TABLE],
  timing: 'BEFORE',
  triggerNames: [
    'inventory_stock_correction_source_evidence_immutable_trg',
    'inventory_stock_correction_source_evidence_coverage_immutable_trg',
  ],
} as const;

/** Migration-owned verifier exact-matches relational scope/provenance with the trusted JSON. */
export const inventoryStockCorrectionSourceEvidenceScopeVerifierContract = {
  businessTime: 'AT_OR_AFTER_AUTHORITY_SELECTION',
  constraintNames: {
    coverage: 'inventory_stock_correction_source_evidence_coverage_exact_scope_ck',
    evidence: 'inventory_stock_correction_source_evidence_exact_scope_ck',
  },
  coverageTriggerName: 'inventory_stock_correction_source_evidence_coverage_exact_scope_trg',
  event: 'INSERT',
  functionName: 'inventory.enforce_stock_correction_source_evidence_exact_scope',
  selectedAuthority: 'ONTOS_WMS_WITH_STOCK_CORRECTION_SUPPORTED',
  table: SOURCE_EVIDENCE_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_stock_correction_source_evidence_exact_scope_trg',
} as const;

/** The deferred verifier proves the JSON coverage and relational rows are an exact bijection. */
export const inventoryStockCorrectionSourceEvidenceCoverageCompletenessContract = {
  childTable: SOURCE_EVIDENCE_COVERAGE_TABLE,
  constraintName: 'inventory_stock_correction_source_evidence_coverage_complete_ck',
  constraintTriggerName: 'inventory_stock_correction_source_evidence_coverage_complete_trg',
  functionName: 'inventory.enforce_stock_correction_source_evidence_coverage_complete',
  mode: 'DEFERRABLE INITIALLY DEFERRED',
  parentTable: SOURCE_EVIDENCE_TABLE,
  relation: 'BIJECTION',
} as const;

/** One exact stream pointer advances only under the WMS owner's lexicographic ordering proof. */
export const inventoryStockCorrectionSourceEvidenceCurrentOrderContract = {
  constraintName: 'inventory_stock_correction_source_evidence_current_transition_ck',
  event: 'INSERT OR UPDATE OR DELETE',
  functionName: 'inventory.enforce_stock_correction_source_evidence_current_transition',
  ordering: 'LEXICOGRAPHIC',
  orderingEvidenceKind: 'OWNER_ORDER_KEY',
  table: SOURCE_EVIDENCE_CURRENT_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_stock_correction_source_evidence_current_transition_trg',
} as const;

export const inventoryStockCorrectionSourceEvidence = inventorySchema.table.withRLS(
  'stock_correction_source_evidence',
  {
    evidenceId: uuid('evidence_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    authorityConfigurationId: uuid('authority_configuration_id').notNull(),
    positionId: uuid('position_id').notNull(),
    stockItemId: uuid('stock_item_id').notNull(),
    stockLocationId: uuid('stock_location_id').notNull(),
    unitModuleId: text('unit_module_id').notNull(),
    unitResourceId: uuid('unit_resource_id').notNull(),
    unitResourceType: text('unit_resource_type').notNull(),
    unitTenantId: uuid('unit_tenant_id').notNull(),
    quantityAmount: text('quantity_amount').notNull(),
    factMeaning: text('fact_meaning').notNull(),
    issuerBackendKind: text('issuer_backend_kind').notNull(),
    issuerBackendId: text('issuer_backend_id').notNull(),
    businessObservedAt: timestamp('business_observed_at', { withTimezone: true }).notNull(),
    orderingEvidenceKind: text('ordering_evidence_kind').notNull(),
    orderingEvidenceValue: text('ordering_evidence_value').notNull(),
    ownerEvidenceRef: text('owner_evidence_ref').notNull(),
    sourceReference: text('source_reference').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    evidenceJson: jsonb('evidence_json').$type<OntosWmsStockCorrectionSourceEvidence>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_stock_correction_source_evidence_tenant_id_uk').on(table.tenantId, table.evidenceId),
    uniqueIndex('inventory_stock_correction_source_evidence_scope_id_uk').on(
      table.tenantId,
      table.customerConfigurationId,
      table.authorityConfigurationId,
      table.positionId,
      table.evidenceId,
    ),
    uniqueIndex('inventory_stock_correction_source_evidence_stream_order_uk').on(
      table.tenantId,
      table.customerConfigurationId,
      table.authorityConfigurationId,
      table.positionId,
      table.orderingEvidenceKind,
      table.orderingEvidenceValue,
    ),
    uniqueIndex('inventory_stock_correction_source_evidence_source_reference_uk').on(
      table.tenantId,
      table.customerConfigurationId,
      table.authorityConfigurationId,
      table.positionId,
      table.sourceReference,
    ),
    index('inventory_stock_correction_source_evidence_stream_observed_idx').on(
      table.tenantId,
      table.customerConfigurationId,
      table.authorityConfigurationId,
      table.positionId,
      table.businessObservedAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.authorityConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_stock_correction_source_evidence_authority_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_stock_correction_source_evidence_position_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_stock_correction_source_evidence_item_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockLocationId],
      foreignColumns: [inventoryStockLocations.tenantId, inventoryStockLocations.stockLocationId],
      name: 'inventory_stock_correction_source_evidence_location_fk',
    }).onDelete('restrict'),
    check(
      'inventory_stock_correction_source_evidence_meaning_ck',
      sql`${table.factMeaning} = 'ABSOLUTE_PHYSICAL_ON_HAND' and ${table.issuerBackendKind} = 'ontos_wms'`,
    ),
    check(
      'inventory_stock_correction_source_evidence_ordering_ck',
      sql`${table.orderingEvidenceKind} = 'OWNER_ORDER_KEY'`,
    ),
    check(
      'inventory_stock_correction_source_evidence_unit_ck',
      sql`${table.unitModuleId} = 'commerce.catalog' and ${table.unitResourceType} = 'commerce.catalog.product-unit' and ${table.unitTenantId} = ${table.tenantId}`,
    ),
    check(
      'inventory_stock_correction_source_evidence_quantity_ck',
      sql`${table.quantityAmount} ~ '^(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$' and length(split_part(${table.quantityAmount}, '.', 1)) <= 29 and (position('.' in ${table.quantityAmount}) = 0 or length(split_part(${table.quantityAmount}, '.', 2)) <= 9)`,
    ),
    check(
      'inventory_stock_correction_source_evidence_text_ck',
      sql`${table.customerConfigurationId} = btrim(${table.customerConfigurationId}) and length(${table.customerConfigurationId}) between 1 and 300 and ${table.issuerBackendId} = btrim(${table.issuerBackendId}) and length(${table.issuerBackendId}) between 1 and 300 and ${table.orderingEvidenceValue} = btrim(${table.orderingEvidenceValue}) and length(${table.orderingEvidenceValue}) between 1 and 300 and ${table.ownerEvidenceRef} = btrim(${table.ownerEvidenceRef}) and length(${table.ownerEvidenceRef}) between 1 and 300 and ${table.sourceReference} = btrim(${table.sourceReference}) and length(${table.sourceReference}) between 1 and 300`,
    ),
    ...tenantRlsPolicies('inventory_stock_correction_source_evidence_tenant', table.tenantId),
  ],
);

export const inventoryStockCorrectionSourceEvidenceCoverage = inventorySchema.table.withRLS(
  'stock_correction_source_evidence_coverage',
  {
    tenantId: uuid('tenant_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    effectId: uuid('effect_id').notNull(),
    relation: text('relation').notNull(),
    ownerEvidenceRef: text('owner_evidence_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.evidenceId, table.effectId],
      name: 'inventory_stock_correction_source_evidence_coverage_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.evidenceId],
      foreignColumns: [
        inventoryStockCorrectionSourceEvidence.tenantId,
        inventoryStockCorrectionSourceEvidence.evidenceId,
      ],
      name: 'inventory_stock_correction_source_evidence_coverage_evidence_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.effectId],
      foreignColumns: [inventoryPhysicalStockEffects.tenantId, inventoryPhysicalStockEffects.effectId],
      name: 'inventory_stock_correction_source_evidence_coverage_effect_fk',
    }).onDelete('restrict'),
    check(
      'inventory_stock_correction_source_evidence_coverage_relation_ck',
      sql`${table.relation} in ('INCLUDES', 'EXCLUDES', 'PREDATES', 'UNKNOWN')`,
    ),
    check(
      'inventory_stock_correction_source_evidence_coverage_evidence_ck',
      sql`${table.ownerEvidenceRef} = btrim(${table.ownerEvidenceRef}) and length(${table.ownerEvidenceRef}) between 1 and 300`,
    ),
    ...tenantRlsPolicies('inventory_stock_correction_source_evidence_coverage_tenant', table.tenantId),
  ],
);

export const inventoryStockCorrectionSourceEvidenceCurrent = inventorySchema.table.withRLS(
  'stock_correction_source_evidence_current',
  {
    tenantId: uuid('tenant_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    authorityConfigurationId: uuid('authority_configuration_id').notNull(),
    positionId: uuid('position_id').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    orderingEvidenceKind: text('ordering_evidence_kind').notNull(),
    orderingEvidenceValue: text('ordering_evidence_value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.customerConfigurationId, table.authorityConfigurationId, table.positionId],
      name: 'inventory_stock_correction_source_evidence_current_pk',
    }),
    uniqueIndex('inventory_stock_correction_source_evidence_current_evidence_uk').on(table.tenantId, table.evidenceId),
    foreignKey({
      columns: [
        table.tenantId,
        table.customerConfigurationId,
        table.authorityConfigurationId,
        table.positionId,
        table.evidenceId,
      ],
      foreignColumns: [
        inventoryStockCorrectionSourceEvidence.tenantId,
        inventoryStockCorrectionSourceEvidence.customerConfigurationId,
        inventoryStockCorrectionSourceEvidence.authorityConfigurationId,
        inventoryStockCorrectionSourceEvidence.positionId,
        inventoryStockCorrectionSourceEvidence.evidenceId,
      ],
      name: 'inventory_stock_correction_source_evidence_current_evidence_fk',
    }).onDelete('restrict'),
    check(
      'inventory_stock_correction_source_evidence_current_ordering_ck',
      sql`${table.orderingEvidenceKind} = 'OWNER_ORDER_KEY' and length(btrim(${table.orderingEvidenceValue})) between 1 and 300`,
    ),
    ...tenantRlsPolicies('inventory_stock_correction_source_evidence_current_tenant', table.tenantId),
  ],
);
