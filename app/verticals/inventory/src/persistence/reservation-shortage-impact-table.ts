/* oxlint-disable perfectionist/sort-objects -- Drizzle declaration order is the physical owner contract; expires: 2027-03-31. */
import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { inventorySchema } from '../database/inventory-schema.ts';
import { inventoryPhysicalStockEffects } from './physical-stock-effect-table.ts';
import { inventoryReservationConfirmations } from './reservation-confirmation-table.ts';
import { inventoryStockCorrections } from './stock-correction-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

export const inventoryReservationShortageImpacts = inventorySchema.table.withRLS(
  'reservation_shortage_impacts',
  {
    tenantId: uuid('tenant_id').notNull(),
    changeKind: text('change_kind').notNull(),
    changeId: uuid('change_id').notNull(),
    physicalEffectId: uuid('physical_effect_id'),
    stockCorrectionId: uuid('stock_correction_id'),
    positionId: uuid('position_id').notNull(),
    positionRevision: integer('position_revision').notNull(),
    availableAmount: numeric('available_amount', { precision: 38, scale: 9 }).notNull(),
    fencedAmount: numeric('fenced_amount', { precision: 38, scale: 9 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    reconciliationRequired: boolean('reconciliation_required').notNull(),
    reason: text('reason'),
    decisionCount: integer('decision_count').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.changeKind, table.changeId],
      name: 'inventory_reservation_shortage_impacts_pk',
    }),
    uniqueIndex('inventory_reservation_shortage_impacts_effect_uk')
      .on(table.tenantId, table.physicalEffectId)
      .where(sql`${table.physicalEffectId} is not null`),
    uniqueIndex('inventory_reservation_shortage_impacts_correction_uk')
      .on(table.tenantId, table.stockCorrectionId)
      .where(sql`${table.stockCorrectionId} is not null`),
    index('inventory_reservation_shortage_impacts_position_time_idx').on(
      table.tenantId,
      table.positionId,
      table.occurredAt,
    ),
    index('inventory_reservation_shortage_impacts_unresolved_idx')
      .on(table.tenantId, table.positionId)
      .where(sql`${table.status} = 'INDETERMINATE'`),
    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [inventoryStockPositions.tenantId, inventoryStockPositions.stockPositionId],
      name: 'inventory_reservation_shortage_impacts_position_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.physicalEffectId],
      foreignColumns: [inventoryPhysicalStockEffects.tenantId, inventoryPhysicalStockEffects.effectId],
      name: 'inventory_reservation_shortage_impacts_effect_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.stockCorrectionId],
      foreignColumns: [inventoryStockCorrections.tenantId, inventoryStockCorrections.correctionId],
      name: 'inventory_reservation_shortage_impacts_correction_fk',
    }).onDelete('restrict'),
    check(
      'inventory_reservation_shortage_impacts_source_ck',
      sql`(${table.changeKind} in ('RECEIPT', 'ISSUE') and ${table.physicalEffectId} = ${table.changeId} and ${table.stockCorrectionId} is null) or (${table.changeKind} = 'CORRECTION' and ${table.stockCorrectionId} = ${table.changeId} and ${table.physicalEffectId} is null)`,
    ),
    check(
      'inventory_reservation_shortage_impacts_outcome_ck',
      sql`(${table.status} = 'DETERMINATE' and ${table.reconciliationRequired} = false and ${table.reason} is null) or (${table.status} = 'INDETERMINATE' and ${table.reconciliationRequired} = true and ${table.reason} = 'AUTHORITATIVE_ISSUANCE_ORDER_UNRESOLVABLE')`,
    ),
    check(
      'inventory_reservation_shortage_impacts_quantity_ck',
      sql`${table.positionRevision} >= 1 and ${table.availableAmount} >= 0 and ${table.fencedAmount} >= 0 and ${table.decisionCount} >= 0`,
    ),
    ...tenantRlsPolicies('inventory_reservation_shortage_impacts_tenant', table.tenantId),
  ],
);

export const inventoryReservationShortageImpactDecisions = inventorySchema.table.withRLS(
  'reservation_shortage_impact_decisions',
  {
    tenantId: uuid('tenant_id').notNull(),
    changeKind: text('change_kind').notNull(),
    changeId: uuid('change_id').notNull(),
    confirmationId: uuid('confirmation_id').notNull(),
    priorityOrdinal: integer('priority_ordinal'),
    decision: text('decision').notNull(),
    affectedAmount: numeric('affected_amount', { precision: 38, scale: 9 }),
    healthBefore: text('health_before').notNull(),
    healthAfter: text('health_after').notNull(),
    confirmationRevisionBefore: integer('confirmation_revision_before').notNull(),
    confirmationRevisionAfter: integer('confirmation_revision_after').notNull(),
    rankIssuedAt: timestamp('rank_issued_at', { withTimezone: true }).notNull(),
    rankOwnerEvidenceRef: text('rank_owner_evidence_ref').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.changeKind, table.changeId, table.confirmationId],
      name: 'inventory_reservation_shortage_impact_decisions_pk',
    }),
    uniqueIndex('inventory_reservation_shortage_impact_decisions_priority_uk')
      .on(table.tenantId, table.changeKind, table.changeId, table.priorityOrdinal)
      .where(sql`${table.priorityOrdinal} is not null`),
    index('inventory_reservation_shortage_impact_decisions_confirmation_idx').on(
      table.tenantId,
      table.confirmationId,
      table.recordedAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.changeKind, table.changeId],
      foreignColumns: [
        inventoryReservationShortageImpacts.tenantId,
        inventoryReservationShortageImpacts.changeKind,
        inventoryReservationShortageImpacts.changeId,
      ],
      name: 'inventory_reservation_shortage_impact_decisions_impact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.confirmationId],
      foreignColumns: [inventoryReservationConfirmations.tenantId, inventoryReservationConfirmations.confirmationId],
      name: 'inventory_reservation_shortage_impact_decisions_confirmation_fk',
    }).onDelete('restrict'),
    check(
      'inventory_reservation_shortage_impact_decisions_meaning_ck',
      sql`${table.decision} in ('HONORABLE', 'SHORTAGE', 'ORDER_UNRESOLVABLE') and ${table.healthBefore} in ('VALID', 'AT_RISK', 'UNVERIFIABLE') and ${table.healthAfter} in ('VALID', 'AT_RISK', 'UNVERIFIABLE') and ${table.confirmationRevisionBefore} >= 1 and ${table.confirmationRevisionAfter} >= ${table.confirmationRevisionBefore} and char_length(btrim(${table.rankOwnerEvidenceRef})) between 1 and 300 and ((${table.decision} = 'ORDER_UNRESOLVABLE' and ${table.priorityOrdinal} is null and ${table.affectedAmount} is null) or (${table.decision} in ('HONORABLE', 'SHORTAGE') and ${table.priorityOrdinal} >= 1 and ${table.affectedAmount} > 0))`,
    ),
    ...tenantRlsPolicies('inventory_reservation_shortage_impact_decisions_tenant', table.tenantId),
  ],
);

export const inventoryReservationShortageImpactContract = {
  decisionSet: {
    constraintTrigger: 'inventory_reservation_shortage_impacts_decision_set_trg',
    functionName: 'inventory.verify_reservation_shortage_impact_decisions',
    timing: 'AFTER INSERT DEFERRABLE INITIALLY DEFERRED',
  },
  immutability: {
    functionName: 'inventory.reject_reservation_shortage_impact_mutation',
    tables: ['inventory.reservation_shortage_impacts', 'inventory.reservation_shortage_impact_decisions'],
    triggers: [
      'inventory_reservation_shortage_impacts_no_mutation_trg',
      'inventory_reservation_shortage_impact_decisions_no_mutation_trg',
    ],
  },
  routines: {
    apply: 'inventory.apply_reservation_shortage_impact_for_worker',
    find: 'inventory.find_reservation_shortage_impact_for_worker',
    readContext: 'inventory.read_reservation_shortage_impact_context_for_worker',
  },
  source: {
    functionName: 'inventory.enforce_reservation_shortage_impact_source',
    triggerName: 'inventory_reservation_shortage_impacts_source_trg',
  },
} as const;

export const INVENTORY_RESERVATION_SHORTAGE_IMPACT_TABLES = [
  inventoryReservationShortageImpactDecisions,
  inventoryReservationShortageImpacts,
] as const;
