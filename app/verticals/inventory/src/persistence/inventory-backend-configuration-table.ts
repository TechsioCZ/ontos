import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { inventorySchema } from '../database/inventory-schema.ts';

export const inventoryBackendConfigurationImmutabilityTriggerContract = {
  columns: [
    'configuration_id',
    'tenant_id',
    'customer_configuration_id',
    'backend_kind',
    'backend_id',
    'exact_reservation_capability',
    'stock_correction_capability',
    'revision',
    'selected_at',
  ],
  errorCondition: 'check_violation',
  event: 'UPDATE_OR_DELETE',
  functionName: 'inventory.reject_backend_configuration_mutation',
  table: 'inventory.backend_configurations',
  timing: 'BEFORE',
  triggerName: 'inventory_backend_configurations_explicit_cutover_trg',
} as const;

export const inventoryBackendConfigurations = inventorySchema.table.withRLS(
  'backend_configurations',
  {
    backendId: text('backend_id').notNull(),
    backendKind: text('backend_kind').notNull(),
    configurationId: uuid('configuration_id').primaryKey(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    exactReservationCapability: text('exact_reservation_capability').notNull(),
    revision: integer('revision').default(1).notNull(),
    selectedAt: timestamp('selected_at', { withTimezone: true }).notNull(),
    stockCorrectionCapability: text('stock_correction_capability').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    uniqueIndex('inventory_backend_configurations_scope_id_uk').on(table.tenantId, table.configurationId),
    uniqueIndex('inventory_backend_configurations_customer_uk').on(table.tenantId, table.customerConfigurationId),
    check(
      'inventory_backend_configurations_identity_ck',
      sql`length(btrim(${table.backendId})) between 1 and 300 and length(btrim(${table.customerConfigurationId})) between 1 and 300`,
    ),
    check(
      'inventory_backend_configurations_backend_ck',
      sql`${table.backendKind} in ('external_business_system', 'ontos_wms')`,
    ),
    check(
      'inventory_backend_configurations_capability_ck',
      sql`${table.exactReservationCapability} in ('SUPPORTED', 'UNSUPPORTED') and (${table.backendKind} <> 'ontos_wms' or ${table.exactReservationCapability} = 'SUPPORTED')`,
    ),
    check(
      'inventory_backend_configurations_stock_correction_capability_ck',
      sql`${table.stockCorrectionCapability} in ('SUPPORTED', 'UNSUPPORTED') and (${table.backendKind} <> 'ontos_wms' or ${table.stockCorrectionCapability} = 'SUPPORTED')`,
    ),
    check('inventory_backend_configurations_revision_ck', sql`${table.revision} = 1`),
    ...tenantRlsPolicies('inventory_backend_configurations_tenant', table.tenantId),
  ],
);
