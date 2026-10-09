/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type {
  InventoryEffectLedgerIntent,
  InventoryEffectLedgerRecord,
  InventoryEffectLedgerResolution,
} from '../../shared/domain/inventory-effect-ledger.ts';
import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';

export const inventoryEffectLedger = inventorySchema.table.withRLS(
  'effect_ledger',
  {
    tenantId: uuid('tenant_id').notNull(),
    effectId: text('effect_id').notNull(),
    effectKind: text('effect_kind').notNull(),
    currentState: text('current_state').default('REQUESTED').notNull(),
    currentRevision: integer('current_revision').default(1).notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    reservationId: uuid('reservation_id'),
    attemptId: text('attempt_id'),
    authorityConfigurationId: uuid('authority_configuration_id').notNull(),
    authorityBackendKind: text('authority_backend_kind').notNull(),
    authorityBackendId: text('authority_backend_id').notNull(),
    intentJson: jsonb('intent_json').$type<InventoryEffectLedgerIntent>().notNull(),
    intentCanonical: text('intent_canonical').notNull(),
    resolutionJson: jsonb('resolution_json').$type<InventoryEffectLedgerResolution>(),
    snapshot: jsonb('snapshot').$type<InventoryEffectLedgerRecord>().notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.effectId], name: 'inventory_effect_ledger_pkey' }),
    index('inventory_effect_ledger_state_idx').on(
      table.tenantId,
      table.currentState,
      table.effectKind,
      table.updatedAt,
    ),
    index('inventory_effect_ledger_reservation_idx').on(table.tenantId, table.reservationId, table.effectKind),
    uniqueIndex('inventory_effect_ledger_commitment_protection_attempt_uk')
      .on(table.tenantId, table.reservationId, table.attemptId, table.effectKind)
      .where(sql`${table.effectKind} = 'ESTABLISH_COMMITMENT_PROTECTION'`),
    foreignKey({
      columns: [table.tenantId, table.authorityConfigurationId],
      foreignColumns: [inventoryBackendConfigurations.tenantId, inventoryBackendConfigurations.configurationId],
      name: 'inventory_effect_ledger_authority_fk',
    }).onDelete('restrict'),
    check(
      'inventory_effect_ledger_kind_ck',
      sql`${table.effectKind} in ('RESERVATION_CREATE', 'RESERVATION_RELEASE', 'ESTABLISH_COMMITMENT_PROTECTION', 'PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE')`,
    ),
    check(
      'inventory_effect_ledger_state_ck',
      sql`${table.currentState} in ('REQUESTED', 'INDETERMINATE', 'SUCCEEDED', 'REJECTED')`,
    ),
    check(
      'inventory_effect_ledger_identity_ck',
      sql`char_length(btrim(${table.effectId})) between 1 and 300 and char_length(btrim(${table.customerConfigurationId})) between 1 and 300 and char_length(btrim(${table.authorityBackendId})) between 1 and 300 and char_length(${table.intentCanonical}) > 0`,
    ),
    check(
      'inventory_effect_ledger_reservation_scope_ck',
      sql`(${table.effectKind} in ('RESERVATION_CREATE', 'RESERVATION_RELEASE', 'ESTABLISH_COMMITMENT_PROTECTION') and ${table.reservationId} is not null and ${table.attemptId} is not null and char_length(btrim(${table.attemptId})) between 1 and 300) or (${table.effectKind} not in ('RESERVATION_CREATE', 'RESERVATION_RELEASE', 'ESTABLISH_COMMITMENT_PROTECTION') and ${table.reservationId} is null and ${table.attemptId} is null)`,
    ),
    check(
      'inventory_effect_ledger_resolution_ck',
      sql`(${table.currentState} = 'REQUESTED' and ${table.resolutionJson} is null) or (${table.currentState} = 'INDETERMINATE') or (${table.currentState} in ('SUCCEEDED', 'REJECTED') and ${table.resolutionJson} is not null)`,
    ),
    check('inventory_effect_ledger_revision_ck', sql`${table.currentRevision} >= 1`),
    ...tenantRlsPolicies('inventory_effect_ledger_tenant', table.tenantId),
  ],
);

export const inventoryEffectLedgerHistory = inventorySchema.table.withRLS(
  'effect_ledger_history',
  {
    historyId: uuid('history_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    effectId: text('effect_id').notNull(),
    revision: integer('revision').notNull(),
    state: text('state').notNull(),
    snapshot: jsonb('snapshot').$type<InventoryEffectLedgerRecord>().notNull(),
    transitionedAt: timestamp('transitioned_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('inventory_effect_ledger_history_scope_id_uk').on(table.tenantId, table.historyId),
    uniqueIndex('inventory_effect_ledger_history_revision_uk').on(table.tenantId, table.effectId, table.revision),
    foreignKey({
      columns: [table.tenantId, table.effectId],
      foreignColumns: [inventoryEffectLedger.tenantId, inventoryEffectLedger.effectId],
      name: 'inventory_effect_ledger_history_effect_fk',
    }).onDelete('restrict'),
    check(
      'inventory_effect_ledger_history_state_ck',
      sql`${table.state} in ('REQUESTED', 'INDETERMINATE', 'SUCCEEDED', 'REJECTED') and ${table.revision} >= 1`,
    ),
    ...tenantRlsPolicies('inventory_effect_ledger_history_tenant', table.tenantId),
  ],
);

export const inventoryEffectLedgerTransitionContract = {
  allowedTransitions: {
    INDETERMINATE: ['INDETERMINATE', 'SUCCEEDED', 'REJECTED'],
    REJECTED: [],
    REQUESTED: ['INDETERMINATE', 'SUCCEEDED', 'REJECTED'],
    SUCCEEDED: [],
  },
  functionName: 'inventory.enforce_effect_ledger_transition',
  immutableColumns: [
    'tenant_id',
    'effect_id',
    'effect_kind',
    'legal_entity_id',
    'customer_configuration_id',
    'reservation_id',
    'attempt_id',
    'authority_configuration_id',
    'authority_backend_kind',
    'authority_backend_id',
    'intent_json',
    'intent_canonical',
    'requested_at',
  ],
  monotonicRevision: true,
  table: 'inventory.effect_ledger',
  triggerName: 'inventory_effect_ledger_transition_trg',
} as const;

export const inventoryEffectLedgerExactScopeContract = {
  constraintName: 'inventory_effect_ledger_exact_scope_ck',
  currentIntentKinds: [
    'RESERVATION_CREATE',
    'RESERVATION_RELEASE',
    'ESTABLISH_COMMITMENT_PROTECTION',
    'PHYSICAL_RECEIPT',
    'PHYSICAL_ISSUE',
  ],
  functionName: 'inventory.enforce_effect_ledger_exact_scope',
  reservedKinds: [],
  table: 'inventory.effect_ledger',
  triggerName: 'inventory_effect_ledger_exact_scope_trg',
} as const;

export const inventoryEffectLedgerHistoryImmutabilityContract = {
  deleteTriggerName: 'inventory_effect_ledger_history_no_delete_trg',
  functionName: 'inventory.reject_effect_ledger_history_mutation',
  table: 'inventory.effect_ledger_history',
  updateTriggerName: 'inventory_effect_ledger_history_no_update_trg',
} as const;

export const INVENTORY_EFFECT_LEDGER_TABLES = [inventoryEffectLedgerHistory, inventoryEffectLedger] as const;
