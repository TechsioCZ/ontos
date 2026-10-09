/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { ReservationConfirmation } from '../../shared/domain/reservation-confirmation.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryObligations } from './inventory-obligation-table.ts';

export const inventoryReservationConfirmations = inventorySchema.table.withRLS(
  'reservation_confirmations',
  {
    confirmationId: uuid('confirmation_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    ownerConfigurationId: uuid('owner_configuration_id').notNull(),
    issuerBackendKind: text('issuer_backend_kind').notNull(),
    issuerBackendId: text('issuer_backend_id').notNull(),
    authorityEffectId: text('authority_effect_id').notNull(),
    ownerEvidenceRef: text('owner_evidence_ref').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    currentHealthState: text('current_health_state').default('VALID').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    snapshot: jsonb('snapshot').$type<ReservationConfirmation>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_reservation_confirmations_scope_id_uk').on(table.tenantId, table.confirmationId),
    uniqueIndex('inventory_reservation_confirmations_reservation_attempt_uk').on(
      table.tenantId,
      table.reservationId,
      table.attemptId,
    ),
    uniqueIndex('inventory_reservation_confirmations_authority_effect_uk').on(table.tenantId, table.authorityEffectId),
    index('inventory_reservation_confirmations_health_rank_idx').on(
      table.tenantId,
      table.currentHealthState,
      table.issuedAt,
      table.ownerEvidenceRef,
    ),
    foreignKey({
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [inventoryObligations.tenantId, inventoryObligations.obligationId],
      name: 'inventory_reservation_confirmations_reservation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.ownerConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_reservation_confirmations_backend_configuration_fk',
    }).onDelete('restrict'),
    check(
      'inventory_reservation_confirmations_meaning_ck',
      sql`char_length(btrim(${table.attemptId})) between 1 and 300 and char_length(btrim(${table.issuerBackendId})) between 1 and 300 and char_length(btrim(${table.authorityEffectId})) between 1 and 300 and char_length(btrim(${table.ownerEvidenceRef})) between 1 and 300 and ${table.issuerBackendKind} in ('external_business_system', 'ontos_wms') and ${table.issuedAt} < ${table.expiresAt}`,
    ),
    check(
      'inventory_reservation_confirmations_health_ck',
      sql`${table.currentHealthState} in ('VALID', 'AT_RISK', 'REVOKED', 'EXPIRED', 'UNVERIFIABLE') and ${table.currentRevision} >= 1`,
    ),
    ...tenantRlsPolicies('inventory_reservation_confirmations_tenant', table.tenantId),
  ],
);

export const inventoryReservationConfirmationHistory = inventorySchema.table.withRLS(
  'reservation_confirmation_history',
  {
    historyId: uuid('history_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    confirmationId: uuid('confirmation_id').notNull(),
    revision: integer('revision').notNull(),
    healthState: text('health_state').notNull(),
    snapshot: jsonb('snapshot').$type<ReservationConfirmation>().notNull(),
    transitionedAt: timestamp('transitioned_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_reservation_confirmation_history_scope_id_uk').on(table.tenantId, table.historyId),
    uniqueIndex('inventory_reservation_confirmation_history_revision_uk').on(
      table.tenantId,
      table.confirmationId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.confirmationId],
      foreignColumns: [inventoryReservationConfirmations.tenantId, inventoryReservationConfirmations.confirmationId],
      name: 'inventory_reservation_confirmation_history_confirmation_fk',
    }).onDelete('restrict'),
    check(
      'inventory_reservation_confirmation_history_health_ck',
      sql`${table.healthState} in ('VALID', 'AT_RISK', 'REVOKED', 'EXPIRED', 'UNVERIFIABLE') and ${table.revision} >= 1`,
    ),
    ...tenantRlsPolicies('inventory_reservation_confirmation_history_tenant', table.tenantId),
  ],
);

export const inventoryReservationConfirmationScopeContract = {
  constraintNames: {
    authority: 'inventory_reservation_confirmations_exact_authority_ck',
    reservation: 'inventory_reservation_confirmations_exact_reservation_ck',
    snapshot: 'inventory_reservation_confirmations_snapshot_ck',
  },
  event: 'INSERT OR UPDATE',
  functionName: 'inventory.enforce_reservation_confirmation_scope',
  table: 'inventory.reservation_confirmations',
  timing: 'BEFORE',
  triggerName: 'inventory_reservation_confirmations_scope_trg',
} as const;

export const inventoryReservationConfirmationLifecycleContract = {
  immutableColumns: [
    'confirmation_id',
    'tenant_id',
    'reservation_id',
    'attempt_id',
    'owner_configuration_id',
    'issuer_backend_kind',
    'issuer_backend_id',
    'authority_effect_id',
    'owner_evidence_ref',
    'issued_at',
    'expires_at',
    'created_at',
  ],
  monotonicRevision: true,
  terminalStates: ['REVOKED', 'EXPIRED'],
  allowedRecoveryStates: ['AT_RISK', 'UNVERIFIABLE'],
  event: 'UPDATE OR DELETE',
  functionName: 'inventory.enforce_reservation_confirmation_lifecycle',
  table: 'inventory.reservation_confirmations',
  timing: 'BEFORE',
  triggerName: 'inventory_reservation_confirmations_lifecycle_trg',
} as const;

export const inventoryReservationConfirmationHistoryImmutabilityContract = {
  deleteTriggerName: 'inventory_reservation_confirmation_history_no_delete_trg',
  functionName: 'inventory.reject_reservation_confirmation_history_mutation',
  table: 'inventory.reservation_confirmation_history',
  updateTriggerName: 'inventory_reservation_confirmation_history_no_update_trg',
} as const;

export const INVENTORY_RESERVATION_CONFIRMATION_TABLES = [
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmations,
] as const;
