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
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { CatalogSelection } from '@app/catalog/domain/catalog-selection-evidence';
import type { StockItem } from '../../shared/domain/stock-item.ts';

import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryStockItems } from './stock-item-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

export const inventoryObligations = inventorySchema.table.withRLS(
  'obligations',
  {
    obligationId: uuid('obligation_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    originKind: text('origin_kind').notNull(),
    lifecycleMeaning: text('lifecycle_meaning').notNull(),
    attemptId: text('attempt_id'),
    acceptedOrderId: text('accepted_order_id'),
    orderEvidenceRef: text('order_evidence_ref'),
    orderEvidenceObservedAt: timestamp('order_evidence_observed_at', { withTimezone: true }),
    sourceSystem: text('source_system'),
    sourceOrderId: text('source_order_id'),
    sourceObligationId: text('source_obligation_id'),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    ownerConfigurationId: uuid('owner_configuration_id').notNull(),
    authorityBackendKind: text('authority_backend_kind').notNull(),
    authorityBackendId: text('authority_backend_id').notNull(),
    authorityExactReservationCapability: text('authority_exact_reservation_capability').notNull(),
    authoritySelectedAt: timestamp('authority_selected_at', { withTimezone: true }).notNull(),
    authorityRevision: integer('authority_revision').default(1).notNull(),
    authorityStockCorrectionCapability: text('authority_stock_correction_capability').notNull(),
    establishedAt: timestamp('established_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_obligations_scope_id_uk').on(table.tenantId, table.obligationId),
    uniqueIndex('inventory_obligations_attempt_uk')
      .on(table.tenantId, table.attemptId)
      .where(sql`${table.originKind} = 'ORDER_COMMITMENT_ATTEMPT'`),
    uniqueIndex('inventory_obligations_imported_lineage_uk')
      .on(table.tenantId, table.sourceSystem, table.sourceOrderId, table.sourceObligationId)
      .where(sql`${table.originKind} = 'IMPORTED_PROVEN_ORDER'`),
    uniqueIndex('inventory_obligations_runtime_accepted_order_uk')
      .on(table.tenantId, table.acceptedOrderId)
      .where(
        sql`${table.originKind} = 'ORDER_COMMITMENT_ATTEMPT' and ${table.lifecycleMeaning} = 'COMMITTED_OBLIGATION'`,
      ),
    foreignKey({
      columns: [table.tenantId, table.ownerConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_obligations_backend_configuration_fk',
    }).onDelete('restrict'),
    check(
      'inventory_obligations_origin_ck',
      sql`(${table.originKind} = 'ORDER_COMMITMENT_ATTEMPT' and ${table.attemptId} is not null and ${table.sourceSystem} is null and ${table.sourceOrderId} is null and ${table.sourceObligationId} is null) or (${table.originKind} = 'IMPORTED_PROVEN_ORDER' and ${table.attemptId} is null and ${table.sourceSystem} is not null and ${table.sourceOrderId} is not null and ${table.sourceObligationId} is not null)`,
    ),
    check(
      'inventory_obligations_lifecycle_ck',
      sql`(${table.originKind} = 'ORDER_COMMITMENT_ATTEMPT' and ((${table.lifecycleMeaning} = 'PROVISIONAL_RESERVATION' and ${table.acceptedOrderId} is null and ${table.orderEvidenceRef} is null and ${table.orderEvidenceObservedAt} is null) or (${table.lifecycleMeaning} = 'COMMITTED_OBLIGATION' and ${table.acceptedOrderId} is not null and ${table.orderEvidenceRef} is not null and ${table.orderEvidenceObservedAt} is not null))) or (${table.originKind} = 'IMPORTED_PROVEN_ORDER' and ${table.lifecycleMeaning} = 'COMMITTED_OBLIGATION' and ${table.acceptedOrderId} is not null and ${table.orderEvidenceRef} is not null and ${table.orderEvidenceObservedAt} is not null)`,
    ),
    check(
      'inventory_obligations_identity_text_ck',
      sql`char_length(btrim(${table.customerConfigurationId})) between 1 and 300 and char_length(btrim(${table.authorityBackendId})) between 1 and 300 and (${table.attemptId} is null or char_length(btrim(${table.attemptId})) between 1 and 300) and (${table.acceptedOrderId} is null or char_length(btrim(${table.acceptedOrderId})) between 1 and 300) and (${table.orderEvidenceRef} is null or char_length(btrim(${table.orderEvidenceRef})) between 1 and 300) and (${table.sourceSystem} is null or char_length(btrim(${table.sourceSystem})) between 1 and 300) and (${table.sourceOrderId} is null or char_length(btrim(${table.sourceOrderId})) between 1 and 300) and (${table.sourceObligationId} is null or char_length(btrim(${table.sourceObligationId})) between 1 and 300)`,
    ),
    check(
      'inventory_obligations_authority_ck',
      sql`${table.authorityBackendKind} in ('external_business_system', 'ontos_wms') and ${table.authorityExactReservationCapability} in ('SUPPORTED', 'UNSUPPORTED') and ${table.authorityStockCorrectionCapability} in ('SUPPORTED', 'UNSUPPORTED') and (${table.authorityBackendKind} <> 'ontos_wms' or (${table.authorityExactReservationCapability} = 'SUPPORTED' and ${table.authorityStockCorrectionCapability} = 'SUPPORTED')) and ${table.authorityRevision} = 1`,
    ),
    ...tenantRlsPolicies('inventory_obligations_tenant', table.tenantId),
  ],
);

export const inventoryObligationRequirements = inventorySchema.table.withRLS(
  'obligation_requirements',
  {
    tenantId: uuid('tenant_id').notNull(),
    obligationId: uuid('obligation_id').notNull(),
    purchaseDemandOccurrenceId: text('purchase_demand_occurrence_id').notNull(),
    bindingId: uuid('binding_id').notNull(),
    catalogSelection: jsonb('catalog_selection').$type<CatalogSelection>().notNull(),
    exactSelectionMeaningId: text('exact_selection_meaning_id').notNull(),
    exactSelectionMeaningKind: text('exact_selection_meaning_kind').notNull(),
    stockItemId: uuid('stock_item_id').notNull(),
    stockItemRevision: integer('stock_item_revision').notNull(),
    stockItemSnapshot: jsonb('stock_item_snapshot').$type<StockItem>().notNull(),
    requestedAmount: numeric('requested_amount', { precision: 38, scale: 9 }).notNull(),
    unitModuleId: text('unit_module_id').notNull(),
    unitResourceId: uuid('unit_resource_id').notNull(),
    unitResourceType: text('unit_resource_type').notNull(),
    unitTenantId: uuid('unit_tenant_id').notNull(),
  },
  (table) => [
    uniqueIndex('inventory_obligation_requirements_occurrence_uk').on(
      table.tenantId,
      table.obligationId,
      table.purchaseDemandOccurrenceId,
    ),
    foreignKey({
      columns: [table.tenantId, table.obligationId],
      foreignColumns: [inventoryObligations.tenantId, inventoryObligations.obligationId],
      name: 'inventory_obligation_requirements_obligation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_obligation_requirements_item_fk',
    }).onDelete('restrict'),
    check(
      'inventory_obligation_requirements_meaning_ck',
      sql`char_length(btrim(${table.purchaseDemandOccurrenceId})) between 1 and 300 and char_length(btrim(${table.exactSelectionMeaningId})) between 1 and 300 and ${table.exactSelectionMeaningKind} in ('PRODUCT_VARIANT', 'PACKAGE_OPTION', 'SET_VARIANT', 'CONFIGURED_SELECTION') and ${table.stockItemRevision} >= 1 and ${table.requestedAmount} >= 0 and ${table.unitModuleId} = 'commerce.catalog' and ${table.unitResourceType} = 'commerce.catalog.product-unit' and ${table.unitTenantId} = ${table.tenantId}`,
    ),
    ...tenantRlsPolicies('inventory_obligation_requirements_tenant', table.tenantId),
  ],
);

export const inventoryObligationAllocations = inventorySchema.table.withRLS(
  'obligation_allocations',
  {
    tenantId: uuid('tenant_id').notNull(),
    obligationId: uuid('obligation_id').notNull(),
    allocationId: text('allocation_id').notNull(),
    purchaseDemandOccurrenceId: text('purchase_demand_occurrence_id').notNull(),
    stockItemId: uuid('stock_item_id').notNull(),
    stockPositionId: uuid('stock_position_id').notNull(),
    allocatedAmount: numeric('allocated_amount', { precision: 38, scale: 9 }).notNull(),
    unitModuleId: text('unit_module_id').notNull(),
    unitResourceId: uuid('unit_resource_id').notNull(),
    unitResourceType: text('unit_resource_type').notNull(),
    unitTenantId: uuid('unit_tenant_id').notNull(),
  },
  (table) => [
    uniqueIndex('inventory_obligation_allocations_identity_uk').on(
      table.tenantId,
      table.obligationId,
      table.allocationId,
    ),
    index('inventory_obligation_allocations_position_idx').on(table.tenantId, table.stockPositionId),
    foreignKey({
      columns: [table.tenantId, table.obligationId, table.purchaseDemandOccurrenceId],
      foreignColumns: [
        inventoryObligationRequirements.tenantId,
        inventoryObligationRequirements.obligationId,
        inventoryObligationRequirements.purchaseDemandOccurrenceId,
      ],
      name: 'inventory_obligation_allocations_requirement_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockPositionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_obligation_allocations_position_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockItemId],
      foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.stockItemId],
      name: 'inventory_obligation_allocations_item_fk',
    }).onDelete('restrict'),
    check(
      'inventory_obligation_allocations_meaning_ck',
      sql`char_length(btrim(${table.allocationId})) between 1 and 300 and ${table.allocatedAmount} >= 0 and ${table.unitModuleId} = 'commerce.catalog' and ${table.unitResourceType} = 'commerce.catalog.product-unit' and ${table.unitTenantId} = ${table.tenantId}`,
    ),
    ...tenantRlsPolicies('inventory_obligation_allocations_tenant', table.tenantId),
  ],
);

/** Migration validation for selected authority snapshots and exact Position Item/Unit/backend scope. */
export const inventoryObligationScopeTriggerContract = {
  constraintNames: {
    allocation: 'inventory_obligation_allocations_exact_scope_ck',
    authority: 'inventory_obligations_exact_authority_ck',
    requirement: 'inventory_obligation_requirements_exact_item_unit_ck',
  },
  functions: {
    allocation: 'inventory.enforce_obligation_allocation_scope',
    authority: 'inventory.enforce_obligation_authority',
    requirement: 'inventory.enforce_obligation_requirement_scope',
  },
  timing: 'BEFORE INSERT OR UPDATE',
} as const;

/** Deferred whole-aggregate validation: every Requirement has one or more exact-cover Allocations. */
export const inventoryObligationCoverageTriggerContract = {
  constraintName: 'inventory_obligations_exact_requirement_coverage_ck',
  functionName: 'inventory.enforce_obligation_requirement_coverage',
  timing: 'AFTER INSERT DEFERRABLE INITIALLY DEFERRED',
  triggerNames: [
    'inventory_obligation_requirements_exact_coverage_trg',
    'inventory_obligation_allocations_exact_coverage_trg',
  ],
} as const;

/** Identity, origin, demand, and allocation snapshots never change after establishment/import. */
export const inventoryObligationImmutabilityContract = {
  functions: {
    allocation: 'inventory.reject_obligation_allocation_mutation',
    obligation: 'inventory.reject_obligation_origin_mutation',
    requirement: 'inventory.reject_obligation_requirement_mutation',
  },
  obligationImmutableColumns: [
    'obligation_id',
    'tenant_id',
    'origin_kind',
    'attempt_id',
    'source_system',
    'source_order_id',
    'source_obligation_id',
    'customer_configuration_id',
    'owner_configuration_id',
    'authority_backend_kind',
    'authority_backend_id',
    'authority_exact_reservation_capability',
    'authority_selected_at',
    'authority_revision',
    'authority_stock_correction_capability',
    'established_at',
    'created_at',
  ],
  importedOriginKind: 'IMPORTED_PROVEN_ORDER',
  importedProofImmutableColumns: [
    'lifecycle_meaning',
    'accepted_order_id',
    'order_evidence_ref',
    'order_evidence_observed_at',
  ],
  rejectChildEvent: 'UPDATE OR DELETE',
  rejectObligationDelete: true,
  runtimeOriginKind: 'ORDER_COMMITMENT_ATTEMPT',
  runtimeTransition: {
    from: 'PROVISIONAL_RESERVATION',
    requiredProofColumns: ['accepted_order_id', 'order_evidence_ref', 'order_evidence_observed_at'],
    to: 'COMMITTED_OBLIGATION',
  },
} as const;

/** The only mutable seam on a runtime Obligation is its authoritative Order-commit promotion. */
export const inventoryObligationCommitTransitionContract = {
  constraintName: 'inventory_obligations_immutable_origin_ck',
  exactMutableColumns: ['lifecycle_meaning', 'accepted_order_id', 'order_evidence_ref', 'order_evidence_observed_at'],
  functionName: 'inventory.reject_obligation_origin_mutation',
  indexName: 'inventory_obligations_runtime_accepted_order_uk',
  requiredProofColumns: ['accepted_order_id', 'order_evidence_ref', 'order_evidence_observed_at'],
  timing: 'BEFORE UPDATE OR DELETE',
  transition: {
    from: 'PROVISIONAL_RESERVATION',
    to: 'COMMITTED_OBLIGATION',
  },
  triggerName: 'inventory_obligations_immutable_origin_trg',
} as const;

export const INVENTORY_OBLIGATION_TABLES = [
  inventoryObligationAllocations,
  inventoryObligationRequirements,
  inventoryObligations,
] as const;
