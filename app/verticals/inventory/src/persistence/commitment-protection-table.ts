/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { CommitmentProtection } from '../../shared/domain/commitment-protection.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryObligations } from './inventory-obligation-table.ts';
import { inventoryReservationConfirmations } from './reservation-confirmation-table.ts';

export const inventoryCommitmentProtections = inventorySchema.table.withRLS(
  'commitment_protections',
  {
    protectionId: uuid('protection_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    confirmationId: uuid('confirmation_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    ownerConfigurationId: uuid('owner_configuration_id').notNull(),
    issuerBackendKind: text('issuer_backend_kind').notNull(),
    issuerBackendId: text('issuer_backend_id').notNull(),
    authorityEffectId: text('authority_effect_id').notNull(),
    ownerEvidenceRef: text('owner_evidence_ref').notNull(),
    establishedAt: timestamp('established_at', { withTimezone: true }).notNull(),
    currentHealthState: text('current_health_state').default('PROTECTED').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    snapshot: jsonb('snapshot').$type<CommitmentProtection>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_commitment_protections_scope_id_uk').on(table.tenantId, table.protectionId),
    uniqueIndex('inventory_commitment_protections_reservation_attempt_uk').on(
      table.tenantId,
      table.reservationId,
      table.attemptId,
    ),
    uniqueIndex('inventory_commitment_protections_confirmation_uk').on(table.tenantId, table.confirmationId),
    uniqueIndex('inventory_commitment_protections_authority_effect_uk').on(table.tenantId, table.authorityEffectId),
    index('inventory_commitment_protections_health_idx').on(
      table.tenantId,
      table.currentHealthState,
      table.establishedAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.confirmationId],
      foreignColumns: [inventoryReservationConfirmations.tenantId, inventoryReservationConfirmations.confirmationId],
      name: 'inventory_commitment_protections_confirmation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [inventoryObligations.tenantId, inventoryObligations.obligationId],
      name: 'inventory_commitment_protections_reservation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.ownerConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_commitment_protections_backend_configuration_fk',
    }).onDelete('restrict'),
    check(
      'inventory_commitment_protections_meaning_ck',
      sql`char_length(btrim(${table.attemptId})) between 1 and 300 and char_length(btrim(${table.issuerBackendId})) between 1 and 300 and char_length(btrim(${table.authorityEffectId})) between 1 and 300 and char_length(btrim(${table.ownerEvidenceRef})) between 1 and 300 and ${table.issuerBackendKind} in ('external_business_system', 'ontos_wms')`,
    ),
    check(
      'inventory_commitment_protections_health_ck',
      sql`${table.currentHealthState} in ('PROTECTED', 'AT_RISK') and ${table.currentRevision} >= 1`,
    ),
    ...tenantRlsPolicies('inventory_commitment_protections_tenant', table.tenantId),
  ],
);

export const inventoryCommitmentProtectionHistory = inventorySchema.table.withRLS(
  'commitment_protection_history',
  {
    historyId: uuid('history_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    protectionId: uuid('protection_id').notNull(),
    revision: integer('revision').notNull(),
    healthState: text('health_state').notNull(),
    snapshot: jsonb('snapshot').$type<CommitmentProtection>().notNull(),
    transitionedAt: timestamp('transitioned_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_commitment_protection_history_scope_id_uk').on(table.tenantId, table.historyId),
    uniqueIndex('inventory_commitment_protection_history_revision_uk').on(
      table.tenantId,
      table.protectionId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.protectionId],
      foreignColumns: [inventoryCommitmentProtections.tenantId, inventoryCommitmentProtections.protectionId],
      name: 'inventory_commitment_protection_history_protection_fk',
    }).onDelete('restrict'),
    check(
      'inventory_commitment_protection_history_health_ck',
      sql`${table.healthState} in ('PROTECTED', 'AT_RISK') and ${table.revision} >= 1`,
    ),
    ...tenantRlsPolicies('inventory_commitment_protection_history_tenant', table.tenantId),
  ],
);

export const inventoryCommitmentProtectionScopeContract = {
  constraintNames: {
    authority: 'inventory_commitment_protections_exact_authority_ck',
    confirmation: 'inventory_commitment_protections_exact_confirmation_ck',
    reservation: 'inventory_commitment_protections_exact_reservation_ck',
    snapshot: 'inventory_commitment_protections_snapshot_ck',
  },
  event: 'INSERT OR UPDATE',
  functionName: 'inventory.enforce_commitment_protection_scope',
  table: 'inventory.commitment_protections',
  timing: 'BEFORE',
  triggerName: 'inventory_commitment_protections_scope_trg',
} as const;

export const inventoryCommitmentProtectionLifecycleContract = {
  allowedTransitions: ['PROTECTED -> AT_RISK', 'AT_RISK -> AT_RISK'],
  immutableColumns: [
    'protection_id',
    'tenant_id',
    'confirmation_id',
    'reservation_id',
    'attempt_id',
    'owner_configuration_id',
    'issuer_backend_kind',
    'issuer_backend_id',
    'authority_effect_id',
    'owner_evidence_ref',
    'established_at',
    'created_at',
  ],
  monotonicRevision: true,
  releaseAllowed: false,
  event: 'UPDATE OR DELETE',
  functionName: 'inventory.enforce_commitment_protection_lifecycle',
  table: 'inventory.commitment_protections',
  timing: 'BEFORE',
  triggerName: 'inventory_commitment_protections_lifecycle_trg',
} as const;

export const inventoryCommitmentProtectionHistoryImmutabilityContract = {
  deleteTriggerName: 'inventory_commitment_protection_history_no_delete_trg',
  functionName: 'inventory.reject_commitment_protection_history_mutation',
  table: 'inventory.commitment_protection_history',
  updateTriggerName: 'inventory_commitment_protection_history_no_update_trg',
} as const;

export const INVENTORY_COMMITMENT_PROTECTION_TABLES = [
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtections,
] as const;
