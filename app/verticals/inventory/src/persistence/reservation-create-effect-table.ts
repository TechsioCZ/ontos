/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type {
  InventoryReservationCreateRequest,
  ReservationCreateEffect,
} from '../../shared/domain/inventory-reservation-create.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';

export const inventoryReservationCreateEffects = inventorySchema.table.withRLS(
  'reservation_create_effects',
  {
    effectId: text('effect_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    mutationId: uuid('mutation_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    backendConfigurationId: uuid('backend_configuration_id').notNull(),
    backendId: text('backend_id').notNull(),
    state: text('state').default('REQUESTED').notNull(),
    requestJson: jsonb('request_json').$type<InventoryReservationCreateRequest>().notNull(),
    recordJson: jsonb('record_json').$type<ReservationCreateEffect>().notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    sourceActionInvocationId: uuid('source_action_invocation_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.effectId], name: 'inventory_reservation_create_effects_pkey' }),
    uniqueIndex('inventory_reservation_create_effects_attempt_uk').on(table.tenantId, table.attemptId),
    uniqueIndex('inventory_reservation_create_effects_mutation_uk').on(table.tenantId, table.mutationId),
    uniqueIndex('inventory_reservation_create_effects_reservation_uk').on(table.tenantId, table.reservationId),
    index('inventory_reservation_create_effects_state_idx').on(table.tenantId, table.state, table.updatedAt),
    foreignKey({
      columns: [table.tenantId, table.backendConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_reservation_create_effects_backend_configuration_fk',
    }).onDelete('restrict'),
    check(
      'inventory_reservation_create_effects_identity_ck',
      sql`char_length(btrim(${table.effectId})) between 1 and 300 and char_length(btrim(${table.attemptId})) between 1 and 300 and char_length(btrim(${table.customerConfigurationId})) between 1 and 300 and char_length(btrim(${table.backendId})) between 1 and 300`,
    ),
    check(
      'inventory_reservation_create_effects_state_ck',
      sql`${table.state} in ('REQUESTED', 'ESTABLISHED', 'RECONCILIATION_REQUIRED', 'INDETERMINATE', 'RESOLVED_NO_RESERVATION')`,
    ),
    ...tenantRlsPolicies('inventory_reservation_create_effects_tenant', table.tenantId),
  ],
);

export const inventoryReservationCreateEffectTransitionContract = {
  constraintName: 'inventory_reservation_create_effects_transition_ck',
  functionName: 'inventory.enforce_reservation_create_effect_transition',
  immutableColumns: [
    'effect_id',
    'tenant_id',
    'legal_entity_id',
    'mutation_id',
    'attempt_id',
    'reservation_id',
    'customer_configuration_id',
    'backend_configuration_id',
    'backend_id',
    'request_json',
    'requested_at',
    'source_action_invocation_id',
  ],
  terminalStates: ['ESTABLISHED', 'RESOLVED_NO_RESERVATION'],
  transitions: [
    'REQUESTED -> ESTABLISHED|RECONCILIATION_REQUIRED|INDETERMINATE|RESOLVED_NO_RESERVATION',
    'RECONCILIATION_REQUIRED|INDETERMINATE -> ESTABLISHED|RECONCILIATION_REQUIRED|INDETERMINATE|RESOLVED_NO_RESERVATION',
    'ESTABLISHED -> ESTABLISHED exact replay only',
    'RESOLVED_NO_RESERVATION -> RESOLVED_NO_RESERVATION exact replay only',
  ],
  triggerName: 'inventory_reservation_create_effects_transition_trg',
} as const;
