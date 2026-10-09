/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type {
  PhysicalStockEffectEvidence,
  PhysicalStockEffectRequest,
} from '../../shared/domain/physical-stock-effect.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

export const inventoryPhysicalStockEffectInsertionVerifierContract = {
  constraintName: 'inventory_physical_stock_effects_exact_scope_ck',
  event: 'INSERT',
  functionName: 'inventory.enforce_physical_stock_effect_scope',
  table: 'inventory.physical_stock_effects',
  timing: 'BEFORE',
  triggerName: 'inventory_physical_stock_effects_exact_scope_trg',
} as const;

export const inventoryPhysicalStockEffectIdentityTriggerContract = {
  columns: [
    'effect_id',
    'tenant_id',
    'kind',
    'customer_configuration_id',
    'legal_entity_id',
    'position_id',
    'stock_item_id',
    'stock_location_id',
    'unit_resource_id',
    'quantity_amount',
    'backend_configuration_id',
    'backend_id',
    'request_json',
    'requested_at',
  ],
  comparison: 'IS DISTINCT FROM',
  errorCondition: 'check_violation',
  event: 'UPDATE OR DELETE',
  functionName: 'inventory.reject_physical_stock_effect_identity_mutation',
  terminalConstraintName: 'inventory_physical_stock_effects_terminal_transition_ck',
  table: 'inventory.physical_stock_effects',
  timing: 'BEFORE',
  triggerName: 'inventory_physical_stock_effects_immutable_identity_trg',
} as const;

export const inventoryPhysicalStockEffects = inventorySchema.table.withRLS(
  'physical_stock_effects',
  {
    effectId: uuid('effect_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    kind: text('kind').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    positionId: uuid('position_id').notNull(),
    stockItemId: uuid('stock_item_id').notNull(),
    stockLocationId: uuid('stock_location_id').notNull(),
    unitResourceId: uuid('unit_resource_id').notNull(),
    quantityAmount: text('quantity_amount').notNull(),
    backendConfigurationId: uuid('backend_configuration_id').notNull(),
    backendId: text('backend_id').notNull(),
    state: text('state').default('REQUESTED').notNull(),
    requestJson: jsonb('request_json').$type<PhysicalStockEffectRequest>().notNull(),
    evidenceJson: jsonb('evidence_json').$type<PhysicalStockEffectEvidence>(),
    terminalReason: text('terminal_reason'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_physical_stock_effects_tenant_id_uk').on(table.tenantId, table.effectId),
    index('inventory_physical_stock_effects_position_idx').on(table.tenantId, table.positionId, table.requestedAt),
    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_physical_stock_effects_position_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.backendConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_physical_stock_effects_backend_configuration_fk',
    }).onDelete('restrict'),
    check('inventory_physical_stock_effects_kind_ck', sql`${table.kind} in ('RECEIPT', 'ISSUE')`),
    check(
      'inventory_physical_stock_effects_state_ck',
      sql`${table.state} in ('REQUESTED', 'APPLIED', 'REJECTED', 'INDETERMINATE')`,
    ),
    check(
      'inventory_physical_stock_effects_terminal_ck',
      sql`(${table.state} = 'REQUESTED' and ${table.evidenceJson} is null and ${table.terminalReason} is null) or (${table.state} = 'APPLIED' and ${table.evidenceJson} is not null and ${table.terminalReason} is null) or (${table.state} in ('REJECTED', 'INDETERMINATE') and ${table.evidenceJson} is null and ${table.terminalReason} is not null)`,
    ),
    ...tenantRlsPolicies('inventory_physical_stock_effects_tenant', table.tenantId),
  ],
);
