/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { InventorySourceAssertion } from '../../shared/domain/inventory-source-assertion.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryExternalStockCorrelations } from './external-stock-correlation-table.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryPhysicalStockEffects } from './physical-stock-effect-table.ts';
import { inventoryStockItems } from './stock-item-table.ts';
import { inventoryStockLocations } from './stock-location-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

const INVENTORY_SOURCE_ASSERTIONS_TABLE = 'inventory.source_assertions';
const INVENTORY_SOURCE_ASSERTION_COVERAGE_TABLE = 'inventory.source_assertion_coverage';

export const inventorySourceAssertionImmutabilityContract = {
  comparison: 'IS DISTINCT FROM',
  errorCondition: 'check_violation',
  event: 'UPDATE OR DELETE',
  functionName: 'inventory.reject_source_assertion_mutation',
  tables: [INVENTORY_SOURCE_ASSERTIONS_TABLE, INVENTORY_SOURCE_ASSERTION_COVERAGE_TABLE],
  timing: 'BEFORE',
  triggerNames: ['inventory_source_assertions_immutable_trg', 'inventory_source_assertion_coverage_immutable_trg'],
} as const;

/** The migration verifier rechecks JSON provenance against these exact relational scope columns. */
export const inventorySourceAssertionScopeVerifierContract = {
  constraintNames: {
    assertion: 'inventory_source_assertions_exact_scope_ck',
    coverage: 'inventory_source_assertion_coverage_exact_scope_ck',
  },
  coverageTable: INVENTORY_SOURCE_ASSERTION_COVERAGE_TABLE,
  coverageTriggerName: 'inventory_source_assertion_coverage_exact_scope_trg',
  event: 'INSERT',
  functionName: 'inventory.enforce_source_assertion_exact_scope',
  table: INVENTORY_SOURCE_ASSERTIONS_TABLE,
  timing: 'BEFORE',
  triggerName: 'inventory_source_assertions_exact_scope_trg',
} as const;

export const inventorySourceAssertionCoverageCompletenessContract = {
  assertionJsonPath: 'coverage',
  childTable: 'inventory.source_assertion_coverage',
  constraintTriggerName: 'inventory_source_assertion_coverage_complete_trg',
  effectRequiredState: 'APPLIED',
  functionName: 'inventory.enforce_source_assertion_coverage_complete',
  mode: 'DEFERRABLE INITIALLY DEFERRED',
  parentTable: 'inventory.source_assertions',
  relation: 'BIJECTION',
} as const;

export const inventorySourceAssertions = inventorySchema.table.withRLS(
  'source_assertions',
  {
    assertionId: uuid('assertion_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    authorityConfigurationId: uuid('authority_configuration_id').notNull(),
    issuerBackendKind: text('issuer_backend_kind').notNull(),
    issuerBackendId: text('issuer_backend_id').notNull(),
    issuerAuthority: text('issuer_authority').notNull(),
    itemCorrelationId: uuid('item_correlation_id').notNull(),
    locationCorrelationId: uuid('location_correlation_id').notNull(),
    positionId: uuid('position_id').notNull(),
    stockItemId: uuid('stock_item_id').notNull(),
    stockLocationId: uuid('stock_location_id').notNull(),
    unitModuleId: text('unit_module_id').notNull(),
    unitResourceId: uuid('unit_resource_id').notNull(),
    unitResourceType: text('unit_resource_type').notNull(),
    unitTenantId: uuid('unit_tenant_id').notNull(),
    quantityAmount: text('quantity_amount').notNull(),
    factMeaning: text('fact_meaning').notNull(),
    businessObservedAt: timestamp('business_observed_at', { withTimezone: true }).notNull(),
    orderingEvidenceKind: text('ordering_evidence_kind').notNull(),
    orderingEvidenceValue: text('ordering_evidence_value').notNull(),
    ownerEvidenceRef: text('owner_evidence_ref').notNull(),
    sourceReference: text('source_reference').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    assertionJson: jsonb('assertion_json').$type<InventorySourceAssertion>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_source_assertions_tenant_id_uk').on(table.tenantId, table.assertionId),
    index('inventory_source_assertions_position_observed_idx').on(
      table.tenantId,
      table.positionId,
      table.businessObservedAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.authorityConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_source_assertions_authority_configuration_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_source_assertions_position_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_source_assertions_item_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockLocationId],
      foreignColumns: [inventoryStockLocations.tenantId, inventoryStockLocations.stockLocationId],
      name: 'inventory_source_assertions_location_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.itemCorrelationId],
      foreignColumns: [inventoryExternalStockCorrelations.tenantId, inventoryExternalStockCorrelations.correlationId],
      name: 'inventory_source_assertions_item_correlation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.locationCorrelationId],
      foreignColumns: [inventoryExternalStockCorrelations.tenantId, inventoryExternalStockCorrelations.correlationId],
      name: 'inventory_source_assertions_location_correlation_fk',
    }).onDelete('restrict'),
    check(
      'inventory_source_assertions_meaning_ck',
      sql`${table.factMeaning} = 'ABSOLUTE_PHYSICAL_ON_HAND' and ${table.issuerBackendKind} = 'external_business_system'`,
    ),
    check(
      'inventory_source_assertions_authority_ck',
      sql`${table.issuerAuthority} in ('SELECTED_BACKEND', 'HISTORICAL_PRE_CUTOVER_ISSUER')`,
    ),
    check(
      'inventory_source_assertions_unit_ck',
      sql`${table.unitModuleId} = 'commerce.catalog' and ${table.unitResourceType} = 'commerce.catalog.product-unit' and ${table.unitTenantId} = ${table.tenantId}`,
    ),
    check(
      'inventory_source_assertions_text_ck',
      sql`length(btrim(${table.customerConfigurationId})) between 1 and 300 and length(btrim(${table.issuerBackendId})) between 1 and 300 and length(btrim(${table.quantityAmount})) between 1 and 50 and length(btrim(${table.orderingEvidenceValue})) between 1 and 300 and length(btrim(${table.ownerEvidenceRef})) between 1 and 300 and length(btrim(${table.sourceReference})) between 1 and 300`,
    ),
    check(
      'inventory_source_assertions_ordering_ck',
      sql`${table.orderingEvidenceKind} in ('SOURCE_REVISION', 'OWNER_ORDER_KEY')`,
    ),
    ...tenantRlsPolicies('inventory_source_assertions_tenant', table.tenantId),
  ],
);

export const inventorySourceAssertionCoverage = inventorySchema.table.withRLS(
  'source_assertion_coverage',
  {
    tenantId: uuid('tenant_id').notNull(),
    assertionId: uuid('assertion_id').notNull(),
    effectId: uuid('effect_id').notNull(),
    relation: text('relation').notNull(),
    ownerEvidenceRef: text('owner_evidence_ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.assertionId, table.effectId],
      name: 'inventory_source_assertion_coverage_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.assertionId],
      foreignColumns: [inventorySourceAssertions.tenantId, inventorySourceAssertions.assertionId],
      name: 'inventory_source_assertion_coverage_assertion_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.effectId],
      foreignColumns: [inventoryPhysicalStockEffects.tenantId, inventoryPhysicalStockEffects.effectId],
      name: 'inventory_source_assertion_coverage_effect_fk',
    }).onDelete('restrict'),
    check(
      'inventory_source_assertion_coverage_relation_ck',
      sql`${table.relation} in ('INCLUDES', 'EXCLUDES', 'PREDATES', 'UNKNOWN')`,
    ),
    check(
      'inventory_source_assertion_coverage_evidence_ck',
      sql`length(btrim(${table.ownerEvidenceRef})) between 1 and 300`,
    ),
    ...tenantRlsPolicies('inventory_source_assertion_coverage_tenant', table.tenantId),
  ],
);
