import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import type { Schema } from 'effect';
import type { AnyPgColumn, PgTableExtraConfigValue } from 'drizzle-orm/pg-core';
import type { CommittedOrderSchema, OrderAcceptanceBundleEncoded } from '../../shared/domain/order-commitment.ts';

export const COMMERCE_ORDER_SCHEMA_NAME = 'commerce_order';
export const commerceOrderSchema = pgSchema(COMMERCE_ORDER_SCHEMA_NAME);
/** Pre-authentication ingress replay identity; never stores credentials or trusted business scope. */
export const gatewayAssertionRedemptions = commerceOrderSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('order_gateway_assertion_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('order_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

const scopeColumns = () => ({
  legalEntityId: uuid('legal_entity_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

/** The exact accepted snapshot is append-only; mutable attempts never rewrite it. */
export const acceptanceBundles = commerceOrderSchema.table.withRLS(
  'acceptance_bundles',
  {
    ...scopeColumns(),
    approvalRequestId: text('approval_request_id').notNull(),
    bundleHash: text('bundle_hash').notNull(),
    bundleId: text('bundle_id').notNull(),
    buyerPrincipalId: uuid('buyer_principal_id').notNull(),
    snapshot: jsonb('snapshot').$type<OrderAcceptanceBundleEncoded>().notNull(),
  },
  (table) => [
    unique('order_bundles_scope_id_uk').on(table.tenantId, table.legalEntityId, table.bundleId),
    unique('order_bundles_binding_uk').on(table.tenantId, table.legalEntityId, table.bundleId, table.bundleHash),
    check('order_bundles_hash_ck', sql`${table.bundleHash} ~ '^[a-f0-9]{64}$'`),
    ...tenantLegalEntityRlsPolicies('order_bundles', table.tenantId, table.legalEntityId),
  ],
);

// Drizzle evaluates these FK callbacks after both tables have been constructed.
// Keep the mutually referring definitions in one binding with an explicitly typed lookup.
const commitmentTables = {
  commitmentAttempts: commerceOrderSchema.table.withRLS(
    'commitment_attempts',
    {
      ...scopeColumns(),
      attemptId: text('attempt_id').notNull(),
      bundleHash: text('bundle_hash').notNull(),
      bundleId: text('bundle_id').notNull(),
      buyerPrincipalId: uuid('buyer_principal_id').notNull(),
      commitmentCorrelationId: text('commitment_correlation_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      orderId: text('order_id'),
      revision: integer('revision').notNull(),
      status: text('status').$type<'READY' | 'PRECOMMIT_FAILED' | 'CANCELLED' | 'COMMITTED'>().notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      unique('order_attempts_scope_id_uk').on(table.tenantId, table.legalEntityId, table.attemptId),
      unique('order_attempts_correlation_uk').on(
        table.tenantId,
        table.legalEntityId,
        table.buyerPrincipalId,
        table.commitmentCorrelationId,
      ),
      foreignKey({
        columns: [table.tenantId, table.legalEntityId, table.bundleId, table.bundleHash],
        foreignColumns: [
          acceptanceBundles.tenantId,
          acceptanceBundles.legalEntityId,
          acceptanceBundles.bundleId,
          acceptanceBundles.bundleHash,
        ],
        name: 'order_attempts_bundle_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.legalEntityId, table.orderId],
        foreignColumns: commitmentTables.orderIdentityColumns(),
        name: 'order_attempts_order_fk',
      }).onDelete('restrict'),
      check('order_attempts_revision_ck', sql`${table.revision} > 0`),
      check('order_attempts_state_ck', sql`${table.status} in ('READY', 'PRECOMMIT_FAILED', 'CANCELLED', 'COMMITTED')`),
      check('order_attempts_order_ck', sql`(${table.status} = 'COMMITTED') = (${table.orderId} is not null)`),
      ...tenantLegalEntityRlsPolicies('order_attempts', table.tenantId, table.legalEntityId),
    ],
  ),
  /** One approval can create only one Order, including concurrent commits of different Attempts. */
  committedOrders: commerceOrderSchema.table.withRLS(
    'committed_orders',
    {
      ...scopeColumns(),
      approvalRequestId: text('approval_request_id').notNull(),
      attemptId: text('attempt_id').notNull(),
      orderId: text('order_id').notNull(),
      snapshot: jsonb('snapshot').$type<Omit<typeof CommittedOrderSchema.Encoded, 'consumptionStatus'>>().notNull(),
    },
    (table): PgTableExtraConfigValue[] => [
      unique('order_orders_scope_id_uk').on(table.tenantId, table.legalEntityId, table.orderId),
      unique('order_orders_attempt_uk').on(table.tenantId, table.legalEntityId, table.attemptId),
      unique('order_orders_approval_request_uk').on(table.tenantId, table.legalEntityId, table.approvalRequestId),
      foreignKey({
        columns: [table.tenantId, table.legalEntityId, table.attemptId],
        foreignColumns: [
          commitmentTables.commitmentAttempts.tenantId,
          commitmentTables.commitmentAttempts.legalEntityId,
          commitmentTables.commitmentAttempts.attemptId,
        ],
        name: 'order_orders_attempt_fk',
      }).onDelete('restrict'),
      ...tenantLegalEntityRlsPolicies('order_orders', table.tenantId, table.legalEntityId),
    ],
  ),
  orderIdentityColumns: (): [AnyPgColumn, AnyPgColumn, AnyPgColumn] => [
    commitmentTables.committedOrders.tenantId,
    commitmentTables.committedOrders.legalEntityId,
    commitmentTables.committedOrders.orderId,
  ],
};
export const { commitmentAttempts, committedOrders } = commitmentTables;

/** Created atomically with the Order. Recovery retries this exact CCC consumption intent. */
export const consumptionObligations = commerceOrderSchema.table.withRLS(
  'consumption_obligations',
  {
    ...scopeColumns(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    consumptionIntent: text('consumption_intent').notNull(),
    orderId: text('order_id').notNull(),
  },
  (table) => [
    unique('order_consumption_order_uk').on(table.tenantId, table.legalEntityId, table.orderId),
    unique('order_consumption_intent_uk').on(table.tenantId, table.legalEntityId, table.consumptionIntent),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.orderId],
      foreignColumns: [committedOrders.tenantId, committedOrders.legalEntityId, committedOrders.orderId],
      name: 'order_consumption_order_fk',
    }).onDelete('restrict'),
    ...tenantLegalEntityRlsPolicies('order_consumption', table.tenantId, table.legalEntityId),
  ],
);

export const commitmentHistory = commerceOrderSchema.table.withRLS(
  'commitment_history',
  {
    ...scopeColumns(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    attemptId: text('attempt_id').notNull(),
    kind: text('kind')
      .$type<'PREPARED' | 'PRECOMMIT_FAILED' | 'CANCELLED' | 'COMMITTED' | 'APPROVAL_CONSUMED'>()
      .notNull(),
    operationId: text('operation_id').notNull(),
    proofResourceId: text('proof_resource_id'),
    revision: integer('revision').notNull(),
  },
  (table) => [
    unique('order_history_revision_uk').on(table.tenantId, table.legalEntityId, table.attemptId, table.revision),
    unique('order_history_operation_uk').on(table.tenantId, table.legalEntityId, table.attemptId, table.operationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.attemptId],
      foreignColumns: [commitmentAttempts.tenantId, commitmentAttempts.legalEntityId, commitmentAttempts.attemptId],
      name: 'order_history_attempt_fk',
    }).onDelete('restrict'),
    check('order_history_revision_ck', sql`${table.revision} > 0`),
    check(
      'order_history_kind_ck',
      sql`${table.kind} in ('PREPARED','PRECOMMIT_FAILED','CANCELLED','COMMITTED','APPROVAL_CONSUMED')`,
    ),
    ...tenantLegalEntityRlsPolicies('order_history', table.tenantId, table.legalEntityId),
  ],
);

/** Durable pending handoff; immutable input and single-assignment completion are enforced natively. */
export const finalizationIntents = commerceOrderSchema.table.withRLS(
  'finalization_intents',
  {
    ...scopeColumns(),
    attemptId: text('attempt_id'),
    businessKey: text('business_key').notNull(),
    buyerPrincipalId: uuid('buyer_principal_id').notNull(),
    data: jsonb('data').$type<Schema.Json>().notNull(),
    inputHash: text('input_hash').notNull(),
    intentId: text('intent_id').notNull(),
    proofRef: text('proof_ref'),
    result: jsonb('result').$type<Schema.Json>(),
    stage: text('stage').$type<'PREPARE' | 'PROOF'>().notNull(),
    status: text('status').$type<'PENDING' | 'COMPLETE' | 'FAILED'>().notNull(),
  },
  (table) => [
    unique('order_finalization_scope_id_uk').on(table.tenantId, table.legalEntityId, table.intentId),
    unique('order_finalization_business_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.buyerPrincipalId,
      table.stage,
      table.businessKey,
    ),
    unique('order_finalization_proof_uk').on(table.tenantId, table.legalEntityId, table.proofRef),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.attemptId],
      foreignColumns: [commitmentAttempts.tenantId, commitmentAttempts.legalEntityId, commitmentAttempts.attemptId],
      name: 'order_finalization_attempt_fk',
    }).onDelete('restrict'),
    check(
      'order_finalization_stage_ck',
      sql`${table.stage} in ('PREPARE','PROOF') and (${table.stage} = 'PROOF') = (${table.attemptId} is not null)`,
    ),
    check(
      'order_finalization_result_ck',
      sql`${table.status} in ('PENDING','COMPLETE','FAILED') and (${table.status} <> 'PENDING') = (${table.result} is not null) and (${table.proofRef} is not null) = (${table.stage} = 'PROOF' and ${table.status} = 'COMPLETE')`,
    ),
    check('order_finalization_hash_ck', sql`${table.inputHash} ~ '^[a-f0-9]{64}$'`),
    ...tenantLegalEntityRlsPolicies('order_finalization', table.tenantId, table.legalEntityId),
  ],
);

export const COMMERCE_ORDER_TABLES = [
  gatewayAssertionRedemptions,
  finalizationIntents,
  acceptanceBundles,
  commitmentAttempts,
  committedOrders,
  consumptionObligations,
  commitmentHistory,
] as const;
export const COMMERCE_ORDER_TABLE_INVENTORY = [
  'gateway_assertion_redemptions',
  'finalization_intents',
  'acceptance_bundles',
  'commitment_attempts',
  'committed_orders',
  'consumption_obligations',
  'commitment_history',
] as const;
export const commerceOrderRelations = defineRelations({
  acceptanceBundles,
  commitmentAttempts,
  commitmentHistory,
  committedOrders,
  consumptionObligations,
  finalizationIntents,
  gatewayAssertionRedemptions,
});
