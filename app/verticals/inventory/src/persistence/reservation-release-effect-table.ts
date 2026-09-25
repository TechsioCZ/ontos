/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { ReservationReleaseEffect } from '../../shared/domain/inventory-reservation-release.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryObligations } from './inventory-obligation-table.ts';

export const inventoryReservationReleaseEffects = inventorySchema.table.withRLS(
  'reservation_release_effects',
  {
    releaseEffectRecordId: uuid('release_effect_record_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    releaseEffectId: text('release_effect_id').notNull(),
    mutationId: uuid('mutation_id').notNull(),
    sourceActionInvocationId: uuid('source_action_invocation_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    ownerConfigurationId: uuid('owner_configuration_id').notNull(),
    issuerBackendKind: text('issuer_backend_kind').notNull(),
    issuerBackendId: text('issuer_backend_id').notNull(),
    currentState: text('current_state').default('REQUESTED').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    snapshot: jsonb('snapshot').$type<ReservationReleaseEffect>().notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    ownerEvidenceRef: text('owner_evidence_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_reservation_release_effects_scope_effect_uk').on(table.tenantId, table.releaseEffectId),
    uniqueIndex('inventory_reservation_release_effects_reservation_uk').on(table.tenantId, table.reservationId),
    uniqueIndex('inventory_reservation_release_effects_mutation_uk').on(table.tenantId, table.mutationId),
    index('inventory_reservation_release_effects_state_idx').on(table.tenantId, table.currentState, table.updatedAt),
    foreignKey({
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [inventoryObligations.tenantId, inventoryObligations.obligationId],
      name: 'inventory_reservation_release_effects_reservation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.ownerConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_reservation_release_effects_backend_configuration_fk',
    }).onDelete('restrict'),
    check(
      'inventory_reservation_release_effects_meaning_ck',
      sql`char_length(btrim(${table.releaseEffectId})) between 1 and 300 and char_length(btrim(${table.attemptId})) between 1 and 300 and char_length(btrim(${table.issuerBackendId})) between 1 and 300 and ${table.issuerBackendKind} in ('external_business_system', 'ontos_wms') and ${table.currentState} in ('REQUESTED', 'INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE') and ${table.currentRevision} >= 1 and ((${table.currentState} = 'RELEASED' and ${table.releasedAt} is not null and ${table.ownerEvidenceRef} is not null) or (${table.currentState} <> 'RELEASED' and ${table.releasedAt} is null and ${table.ownerEvidenceRef} is null))`,
    ),
    ...tenantRlsPolicies('inventory_reservation_release_effects_tenant', table.tenantId),
  ],
);

export const inventoryReservationReleaseEffectHistory = inventorySchema.table.withRLS(
  'reservation_release_effect_history',
  {
    historyId: uuid('history_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    releaseEffectId: text('release_effect_id').notNull(),
    revision: integer('revision').notNull(),
    state: text('state').notNull(),
    snapshot: jsonb('snapshot').$type<ReservationReleaseEffect>().notNull(),
    transitionedAt: timestamp('transitioned_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_reservation_release_effect_history_scope_id_uk').on(table.tenantId, table.historyId),
    uniqueIndex('inventory_reservation_release_effect_history_revision_uk').on(
      table.tenantId,
      table.releaseEffectId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.releaseEffectId],
      foreignColumns: [inventoryReservationReleaseEffects.tenantId, inventoryReservationReleaseEffects.releaseEffectId],
      name: 'inventory_reservation_release_effect_history_effect_fk',
    }).onDelete('restrict'),
    check(
      'inventory_reservation_release_effect_history_meaning_ck',
      sql`${table.state} in ('REQUESTED', 'INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE') and ${table.revision} >= 1`,
    ),
    ...tenantRlsPolicies('inventory_reservation_release_effect_history_tenant', table.tenantId),
  ],
);

export const inventoryReservationReleaseEffectTransitionContract = {
  allowedTransitions: {
    INDETERMINATE: ['INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE'],
    NOT_RELEASABLE: [],
    RELEASED: [],
    REQUESTED: ['INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE'],
  },
  immutableColumns: [
    'release_effect_record_id',
    'tenant_id',
    'release_effect_id',
    'mutation_id',
    'source_action_invocation_id',
    'legal_entity_id',
    'reservation_id',
    'attempt_id',
    'owner_configuration_id',
    'issuer_backend_kind',
    'issuer_backend_id',
    'requested_at',
    'created_at',
  ],
  monotonicRevision: true,
  functionName: 'inventory.enforce_reservation_release_effect_transition',
  table: 'inventory.reservation_release_effects',
  triggerName: 'inventory_reservation_release_effects_transition_trg',
} as const;

export const inventoryReservationReleaseEffectScopeContract = {
  functionName: 'inventory.enforce_reservation_release_effect_scope',
  table: 'inventory.reservation_release_effects',
  timing: 'BEFORE',
  triggerEvent: 'INSERT OR UPDATE',
  triggerName: 'inventory_reservation_release_effects_scope_trg',
} as const;

export const inventoryReservationReleaseEffectHistoryImmutabilityContract = {
  deleteTriggerName: 'inventory_reservation_release_effect_history_no_delete_trg',
  functionName: 'inventory.reject_reservation_release_effect_history_mutation',
  table: 'inventory.reservation_release_effect_history',
  updateTriggerName: 'inventory_reservation_release_effect_history_no_update_trg',
} as const;

export const INVENTORY_RESERVATION_RELEASE_TABLES = [
  inventoryReservationReleaseEffectHistory,
  inventoryReservationReleaseEffects,
] as const;
