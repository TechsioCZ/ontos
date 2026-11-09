import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Schema } from 'effect';

import {
  PAYMENT_AUTHORIZATION_PROOF_KINDS,
  PAYMENT_CORRECTION_EFFECTS,
  PAYMENT_METHODS,
  PAYMENT_OBSERVATION_ACCEPTANCE_OUTCOMES,
  PAYMENT_OBSERVATION_FACT_KINDS,
  PAYMENT_OPERATION_KINDS,
  PAYMENT_OPERATION_OUTCOMES,
  PAYMENT_OUTCOME_TRANSITION_CAUSES,
  PAYMENT_RECONCILIATION_CASE_KINDS,
  PAYMENT_RECONCILIATION_CASE_STATUSES,
  PAYMENT_RECONCILIATION_DECISION_KINDS,
  PAYMENT_RECOVERY_MODES,
  PAYMENT_REFUND_BASIS_KINDS,
  PAYMENT_SOURCE_AUTHORITY_STATUSES,
  PAYMENT_SOURCE_FACT_FAMILIES,
  PAYMENT_SOURCE_KINDS,
} from '../../shared/domain/payment-vocabulary.ts';
import type {
  PaymentAuthorizationProofKind,
  PaymentCorrectionEffectKind,
  PaymentMethod,
  PaymentObservationAcceptanceOutcome,
  PaymentObservationFactKind,
  PaymentOperationKind,
  PaymentOperationOutcome,
  PaymentOutcomeTransitionCause,
  PaymentReconciliationCaseKind,
  PaymentReconciliationCaseStatus,
  PaymentReconciliationDecisionKind,
  PaymentRecoveryMode,
  PaymentRefundBasisKind,
  PaymentSourceAuthorityStatus,
  PaymentSourceFactFamily,
  PaymentSourceKind,
} from '../../shared/domain/payment-vocabulary.ts';
import { PAYMENT_LAUNCH_CURRENCY } from '../../shared/domain/payment-money.ts';

export const PAYMENT_SCHEMA_NAME = 'payment';
export const paymentSchema = pgSchema(PAYMENT_SCHEMA_NAME);

/** Constant vocabulary rendered once into CHECK constraints; never caller data. */
const literalList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '));
const maximumAmountMinor = sql.raw(String(Number.MAX_SAFE_INTEGER));
const launchCurrency = sql.raw(`'${PAYMENT_LAUNCH_CURRENCY}'`);

const scopeColumns = () => ({
  legalEntityId: uuid('legal_entity_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

/** Truthful execution provenance of the governed write that appended a row (#1148/#1151 R1/R2). */
const provenanceColumns = () => ({
  actionInvocationId: uuid('action_invocation_id').notNull(),
  actorPrincipalId: uuid('actor_principal_id').notNull(),
  compositionRevision: text('composition_revision').notNull(),
});

const compositionRevisionCheck = (name: string, column: AnyPgColumn) => check(name, sql`${column} ~ '^[a-f0-9]{64}$'`);
const reasonCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} = btrim(${column}) and length(${column}) between 1 and 1000`);
const opaqueCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} = btrim(${column}) and length(${column}) between 1 and 200`);

/** Pre-authentication ingress replay identity; never stores credentials or trusted business scope. */
export const gatewayAssertionRedemptions = paymentSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('payment_gateway_assertion_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('payment_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

/** Current merchant method enablement in Customer Configuration + Selling Legal Entity scope (#1147). */
export const methodEnablements = paymentSchema.table.withRLS(
  'method_enablements',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    configuredAt: timestamp('configured_at', { withTimezone: true }).notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    enabled: boolean('enabled').notNull(),
    method: text('method').$type<PaymentMethod>().notNull(),
    methodEnablementId: uuid('method_enablement_id').defaultRandom().primaryKey(),
    reason: text('reason').notNull(),
    revision: integer('revision').notNull(),
  },
  (table) => [
    unique('payment_method_enablements_scope_id_uk').on(table.tenantId, table.legalEntityId, table.methodEnablementId),
    unique('payment_method_enablements_identity_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.customerConfigurationId,
      table.method,
    ),
    check('payment_method_enablements_method_ck', sql`${table.method} in (${literalList(PAYMENT_METHODS)})`),
    check('payment_method_enablements_revision_ck', sql`${table.revision} > 0`),
    opaqueCheck('payment_method_enablements_configuration_ck', table.customerConfigurationId),
    reasonCheck('payment_method_enablements_reason_ck', table.reason),
    compositionRevisionCheck('payment_method_enablements_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_method_enablements', table.tenantId, table.legalEntityId),
  ],
);

/** Append-only history of every enablement revision. */
export const methodEnablementRevisions = paymentSchema.table.withRLS(
  'method_enablement_revisions',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    enabled: boolean('enabled').notNull(),
    method: text('method').$type<PaymentMethod>().notNull(),
    methodEnablementId: uuid('method_enablement_id').notNull(),
    methodEnablementRevisionId: uuid('method_enablement_revision_id').defaultRandom().primaryKey(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    revision: integer('revision').notNull(),
  },
  (table) => [
    unique('payment_method_enablement_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.methodEnablementId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.methodEnablementId],
      foreignColumns: [
        methodEnablements.tenantId,
        methodEnablements.legalEntityId,
        methodEnablements.methodEnablementId,
      ],
      name: 'payment_method_enablement_revisions_current_fk',
    }).onDelete('restrict'),
    check('payment_method_enablement_revisions_method_ck', sql`${table.method} in (${literalList(PAYMENT_METHODS)})`),
    check('payment_method_enablement_revisions_revision_ck', sql`${table.revision} > 0`),
    reasonCheck('payment_method_enablement_revisions_reason_ck', table.reason),
    compositionRevisionCheck('payment_method_enablement_revisions_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_method_enablement_revisions', table.tenantId, table.legalEntityId),
  ],
);

/** Current configured source authority per fact family (#1152). */
export const sourceAuthorities = paymentSchema.table.withRLS(
  'source_authorities',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    accountRef: text('account_ref').notNull(),
    configuredAt: timestamp('configured_at', { withTimezone: true }).notNull(),
    environment: text('environment').notNull(),
    factFamily: text('fact_family').$type<PaymentSourceFactFamily>().notNull(),
    method: text('method').$type<PaymentMethod>(),
    reason: text('reason').notNull(),
    refundRoute: boolean('refund_route').notNull(),
    revision: integer('revision').notNull(),
    sourceAuthorityId: uuid('source_authority_id').defaultRandom().primaryKey(),
    sourceKind: text('source_kind').$type<PaymentSourceKind>().notNull(),
    sourceSystem: text('source_system').notNull(),
    status: text('status').$type<PaymentSourceAuthorityStatus>().notNull(),
  },
  (table) => [
    unique('payment_source_authorities_scope_id_uk').on(table.tenantId, table.legalEntityId, table.sourceAuthorityId),
    unique('payment_source_authorities_identity_uk')
      .on(
        table.tenantId,
        table.legalEntityId,
        table.factFamily,
        table.method,
        table.sourceKind,
        table.sourceSystem,
        table.accountRef,
        table.environment,
      )
      .nullsNotDistinct(),
    check(
      'payment_source_authorities_family_ck',
      sql`${table.factFamily} in (${literalList(PAYMENT_SOURCE_FACT_FAMILIES)})`,
    ),
    check(
      'payment_source_authorities_method_ck',
      sql`${table.method} is null or ${table.method} in (${literalList(PAYMENT_METHODS)})`,
    ),
    check('payment_source_authorities_kind_ck', sql`${table.sourceKind} in (${literalList(PAYMENT_SOURCE_KINDS)})`),
    check(
      'payment_source_authorities_status_ck',
      sql`${table.status} in (${literalList(PAYMENT_SOURCE_AUTHORITY_STATUSES)})`,
    ),
    check('payment_source_authorities_revision_ck', sql`${table.revision} > 0`),
    opaqueCheck('payment_source_authorities_system_ck', table.sourceSystem),
    opaqueCheck('payment_source_authorities_account_ck', table.accountRef),
    opaqueCheck('payment_source_authorities_environment_ck', table.environment),
    reasonCheck('payment_source_authorities_reason_ck', table.reason),
    compositionRevisionCheck('payment_source_authorities_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_source_authorities', table.tenantId, table.legalEntityId),
  ],
);

/** Append-only history of every source authority revision. */
export const sourceAuthorityRevisions = paymentSchema.table.withRLS(
  'source_authority_revisions',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    refundRoute: boolean('refund_route').notNull(),
    revision: integer('revision').notNull(),
    sourceAuthorityId: uuid('source_authority_id').notNull(),
    sourceAuthorityRevisionId: uuid('source_authority_revision_id').defaultRandom().primaryKey(),
    status: text('status').$type<PaymentSourceAuthorityStatus>().notNull(),
    /**
     * The principals allowed to submit statements as this source at this revision (#1152/#1153): the
     * configured integration/provider or operator principals. The authority's Current binding is the
     * set of its current revision; a revoked binding is a later revision without that principal.
     */
    submitterPrincipalIds: uuid('submitter_principal_ids').array().notNull(),
  },
  (table) => [
    unique('payment_source_authority_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceAuthorityId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.sourceAuthorityId],
      foreignColumns: [
        sourceAuthorities.tenantId,
        sourceAuthorities.legalEntityId,
        sourceAuthorities.sourceAuthorityId,
      ],
      name: 'payment_source_authority_revisions_current_fk',
    }).onDelete('restrict'),
    check(
      'payment_source_authority_revisions_status_ck',
      sql`${table.status} in (${literalList(PAYMENT_SOURCE_AUTHORITY_STATUSES)})`,
    ),
    check('payment_source_authority_revisions_revision_ck', sql`${table.revision} > 0`),
    check(
      'payment_source_authority_revisions_submitters_ck',
      sql`cardinality(${table.submitterPrincipalIds}) between 1 and 100 and array_ndims(${table.submitterPrincipalIds}) = 1 and array_position(${table.submitterPrincipalIds}, null) is null`,
    ),
    reasonCheck('payment_source_authority_revisions_reason_ck', table.reason),
    compositionRevisionCheck('payment_source_authority_revisions_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_source_authority_revisions', table.tenantId, table.legalEntityId),
  ],
);

/**
 * The Payment aggregate (#1148): one exact amount/currency/method/term meaning for one purchase.
 * Material columns are immutable (trigger); only coverage_revision and aggregate_version advance.
 */
export const payments = paymentSchema.table.withRLS(
  'payments',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    aggregateVersion: integer('aggregate_version').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    coverageRevision: integer('coverage_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    currency: text('currency').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    executionBinding: jsonb('execution_binding').$type<Schema.Json>().notNull(),
    intentKey: text('intent_key').notNull(),
    materialHash: text('material_hash').notNull(),
    method: text('method').$type<PaymentMethod>().notNull(),
    paymentId: uuid('payment_id').defaultRandom().primaryKey(),
    paymentTermRef: jsonb('payment_term_ref').$type<Schema.Json>().notNull(),
    predecessorPaymentId: uuid('predecessor_payment_id'),
    purchaseCorrelationId: text('purchase_correlation_id').notNull(),
    /**
     * The trusted Commerce Purchasing Context the intent was created for (#1147/#1149): buyer subject,
     * Channel, Commerce Market and context revision. Immutable; every later entitlement/policy question
     * about this Payment is scoped to exactly this purchase.
     */
    purchasingContext: jsonb('purchasing_context').$type<Schema.Json>().notNull(),
    termSemanticEvidence: jsonb('term_semantic_evidence').$type<Schema.Json>().notNull(),
  },
  (table) => [
    unique('payment_payments_scope_id_uk').on(table.tenantId, table.legalEntityId, table.paymentId),
    unique('payment_payments_intent_key_uk').on(table.tenantId, table.legalEntityId, table.intentKey),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.predecessorPaymentId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.paymentId],
      name: 'payment_payments_predecessor_fk',
    }).onDelete('restrict'),
    index('payment_payments_purchase_idx').on(table.tenantId, table.legalEntityId, table.purchaseCorrelationId),
    check(
      'payment_payments_amount_ck',
      sql`${table.amountMinor} between 0 and ${maximumAmountMinor} and ${table.currency} = ${launchCurrency}`,
    ),
    check('payment_payments_method_ck', sql`${table.method} in (${literalList(PAYMENT_METHODS)})`),
    check('payment_payments_revisions_ck', sql`${table.coverageRevision} > 0 and ${table.aggregateVersion} > 0`),
    check(
      'payment_payments_predecessor_ck',
      sql`${table.predecessorPaymentId} is null or ${table.predecessorPaymentId} <> ${table.paymentId}`,
    ),
    check('payment_payments_material_hash_ck', sql`${table.materialHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'payment_payments_binding_ck',
      sql`jsonb_typeof(${table.executionBinding}) = 'object' and jsonb_typeof(${table.paymentTermRef}) = 'object' and jsonb_typeof(${table.termSemanticEvidence}) = 'object'`,
    ),
    opaqueCheck('payment_payments_purchase_ck', table.purchaseCorrelationId),
    check('payment_payments_purchasing_context_ck', sql`jsonb_typeof(${table.purchasingContext}) = 'object'`),
    opaqueCheck('payment_payments_configuration_ck', table.customerConfigurationId),
    check('payment_payments_intent_key_ck', sql`${table.intentKey} ~ '^[!-~]{1,200}$'`),
    compositionRevisionCheck('payment_payments_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_payments', table.tenantId, table.legalEntityId),
  ],
);

/**
 * One immutable logical monetary operation (#1148). Material intent never changes; the outcome
 * advances only together with an appended `operation_outcome_transitions` row.
 */
export const paymentOperations = paymentSchema.table.withRLS(
  'payment_operations',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    binding: jsonb('binding').$type<Schema.Json>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    currency: text('currency').notNull(),
    kind: text('kind').$type<PaymentOperationKind>().notNull(),
    materialHash: text('material_hash').notNull(),
    materialRequest: jsonb('material_request').$type<Schema.Json>().notNull(),
    operationId: uuid('operation_id').defaultRandom().primaryKey(),
    operationKey: text('operation_key').notNull(),
    outcome: text('outcome').$type<PaymentOperationOutcome>().notNull(),
    outcomeRevision: integer('outcome_revision').notNull(),
    paymentId: uuid('payment_id').notNull(),
    refundBasis: jsonb('refund_basis').$type<Schema.Json>(),
    refundBasisKind: text('refund_basis_kind').$type<PaymentRefundBasisKind>(),
    /**
     * The configured refund executor a REFUND was requested through (#1150/#1152): required on every
     * REFUND and absent otherwise; immutable, so a later configuration change never reroutes it and
     * evidence/recovery qualify against it.
     */
    refundExecutionRoute: jsonb('refund_execution_route').$type<Schema.Json>(),
    targetOperationId: uuid('target_operation_id'),
  },
  (table) => [
    unique('payment_operations_scope_id_uk').on(table.tenantId, table.legalEntityId, table.operationId),
    unique('payment_operations_payment_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.paymentId,
      table.operationId,
    ),
    unique('payment_operations_key_uk').on(table.tenantId, table.legalEntityId, table.paymentId, table.operationKey),
    /** At most one live-or-proven COLLECT lineage per Payment (#1148 aggregate invariant backstop). */
    uniqueIndex('payment_operations_one_collect_lineage_uk')
      .on(table.tenantId, table.legalEntityId, table.paymentId)
      .where(sql`${table.kind} = 'COLLECT' and ${table.outcome} <> 'NOT_EFFECTED_CONFIRMED'`),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.legalEntityId, payments.paymentId],
      name: 'payment_operations_payment_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.targetOperationId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.paymentId, table.operationId],
      name: 'payment_operations_target_fk',
    }).onDelete('restrict'),
    check('payment_operations_kind_ck', sql`${table.kind} in (${literalList(PAYMENT_OPERATION_KINDS)})`),
    check('payment_operations_outcome_ck', sql`${table.outcome} in (${literalList(PAYMENT_OPERATION_OUTCOMES)})`),
    check(
      'payment_operations_amount_ck',
      sql`${table.amountMinor} between 0 and ${maximumAmountMinor} and ${table.currency} = ${launchCurrency} and (${table.kind} = 'CANCEL_OR_VOID' or ${table.amountMinor} > 0)`,
    ),
    check(
      'payment_operations_target_ck',
      sql`(${table.kind} = 'COLLECT') = (${table.targetOperationId} is null) and (${table.targetOperationId} is null or ${table.targetOperationId} <> ${table.operationId})`,
    ),
    check(
      'payment_operations_refund_basis_ck',
      sql`((${table.kind} = 'REFUND') = (${table.refundBasisKind} is not null)) and ((${table.refundBasisKind} is null) = (${table.refundBasis} is null)) and (${table.refundBasisKind} is null or (${table.refundBasisKind} in (${literalList(PAYMENT_REFUND_BASIS_KINDS)}) and ${table.refundBasis}->>'_tag' = ${table.refundBasisKind}))`,
    ),
    check(
      'payment_operations_refund_route_ck',
      sql`(${table.kind} = 'REFUND') = (${table.refundExecutionRoute} is not null) and (${table.refundExecutionRoute} is null or jsonb_typeof(${table.refundExecutionRoute}) = 'object')`,
    ),
    check('payment_operations_outcome_revision_ck', sql`${table.outcomeRevision} > 0`),
    check('payment_operations_material_hash_ck', sql`${table.materialHash} ~ '^[a-f0-9]{64}$'`),
    check('payment_operations_key_ck', sql`${table.operationKey} ~ '^[!-~]{1,200}$'`),
    compositionRevisionCheck('payment_operations_composition_ck', table.compositionRevision),
    index('payment_operations_target_idx').on(table.tenantId, table.legalEntityId, table.targetOperationId),
    ...tenantLegalEntityRlsPolicies('payment_operations', table.tenantId, table.legalEntityId),
  ],
);

/** Append-only outcome lineage; every outcome change records its cause and true execution provenance. */
export const operationOutcomeTransitions = paymentSchema.table.withRLS(
  'operation_outcome_transitions',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    causeId: text('cause_id'),
    causeKind: text('cause_kind').$type<PaymentOutcomeTransitionCause>().notNull(),
    fromOutcome: text('from_outcome').$type<PaymentOperationOutcome>(),
    operationId: uuid('operation_id').notNull(),
    outcomeRevision: integer('outcome_revision').notNull(),
    paymentId: uuid('payment_id').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    toOutcome: text('to_outcome').$type<PaymentOperationOutcome>().notNull(),
    transitionId: uuid('transition_id').defaultRandom().primaryKey(),
  },
  (table) => [
    unique('payment_outcome_transitions_revision_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.operationId,
      table.outcomeRevision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.operationId],
      foreignColumns: [
        paymentOperations.tenantId,
        paymentOperations.legalEntityId,
        paymentOperations.paymentId,
        paymentOperations.operationId,
      ],
      name: 'payment_outcome_transitions_operation_fk',
    }).onDelete('restrict'),
    check(
      'payment_outcome_transitions_cause_ck',
      sql`${table.causeKind} in (${literalList(PAYMENT_OUTCOME_TRANSITION_CAUSES)}) and (${table.causeKind} = 'CREATION') = (${table.fromOutcome} is null) and (${table.causeKind} = 'CREATION') = (${table.outcomeRevision} = 1) and (${table.causeId} is null or (${table.causeId} = btrim(${table.causeId}) and length(${table.causeId}) between 1 and 200))`,
    ),
    check(
      'payment_outcome_transitions_outcome_ck',
      sql`${table.toOutcome} in (${literalList(PAYMENT_OPERATION_OUTCOMES)}) and (${table.fromOutcome} is null or (${table.fromOutcome} in (${literalList(PAYMENT_OPERATION_OUTCOMES)}) and ${table.fromOutcome} <> ${table.toOutcome}))`,
    ),
    check('payment_outcome_transitions_revision_ck', sql`${table.outcomeRevision} > 0`),
    compositionRevisionCheck('payment_outcome_transitions_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_outcome_transitions', table.tenantId, table.legalEntityId),
  ],
);

/**
 * Item reservations of REFUNDABLE_ITEMS refunds (#1150). A claim stays active while the refund is
 * live or confirmed; it is released only by definitive NOT_EFFECTED_CONFIRMED evidence.
 */
export const refundItemClaims = paymentSchema.table.withRLS(
  'refund_item_claims',
  {
    ...scopeColumns(),
    active: boolean('active').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull(),
    claimId: uuid('claim_id').defaultRandom().primaryKey(),
    currency: text('currency').notNull(),
    itemRef: text('item_ref').notNull(),
    operationId: uuid('operation_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedByActionInvocationId: uuid('released_by_action_invocation_id'),
    sourceEvidenceRef: text('source_evidence_ref').notNull(),
  },
  (table) => [
    unique('payment_refund_item_claims_operation_item_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.operationId,
      table.itemRef,
    ),
    uniqueIndex('payment_refund_item_claims_active_item_uk')
      .on(table.tenantId, table.legalEntityId, table.paymentId, table.itemRef)
      .where(sql`${table.active}`),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.operationId],
      foreignColumns: [
        paymentOperations.tenantId,
        paymentOperations.legalEntityId,
        paymentOperations.paymentId,
        paymentOperations.operationId,
      ],
      name: 'payment_refund_item_claims_operation_fk',
    }).onDelete('restrict'),
    check(
      'payment_refund_item_claims_amount_ck',
      sql`${table.amountMinor} between 1 and ${maximumAmountMinor} and ${table.currency} = ${launchCurrency}`,
    ),
    check(
      'payment_refund_item_claims_release_ck',
      sql`${table.active} = (${table.releasedAt} is null) and ${table.active} = (${table.releasedByActionInvocationId} is null)`,
    ),
    opaqueCheck('payment_refund_item_claims_item_ck', table.itemRef),
    opaqueCheck('payment_refund_item_claims_evidence_ck', table.sourceEvidenceRef),
    ...tenantLegalEntityRlsPolicies('payment_refund_item_claims', table.tenantId, table.legalEntityId),
  ],
);

/** Immutable qualified source evidence and its recorded acceptance decision (#1151/#1152). */
export const observations = paymentSchema.table.withRLS(
  'observations',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    acceptanceOutcome: text('acceptance_outcome').$type<PaymentObservationAcceptanceOutcome>().notNull(),
    accountRef: text('account_ref').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }),
    /** Required exactly for an accepted SOURCE_CORRECTION; only REDUCE_ESTABLISHED_COLLECTION reduces coverage. */
    correctionEffect: text('correction_effect').$type<PaymentCorrectionEffectKind>(),
    correctsObservationId: uuid('corrects_observation_id'),
    currency: text('currency'),
    economicEffectKey: text('economic_effect_key'),
    environment: text('environment').notNull(),
    evidenceRef: text('evidence_ref'),
    factFamily: text('fact_family').$type<PaymentSourceFactFamily>().notNull(),
    factKind: text('fact_kind').$type<PaymentObservationFactKind>().notNull(),
    observationId: uuid('observation_id').defaultRandom().primaryKey(),
    operationId: uuid('operation_id'),
    paymentId: uuid('payment_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    sourceAuthorityId: uuid('source_authority_id'),
    sourceAuthorityRevision: integer('source_authority_revision'),
    sourceKind: text('source_kind').$type<PaymentSourceKind>().notNull(),
    sourceOccurredAt: timestamp('source_occurred_at', { withTimezone: true }),
    sourceOccurrenceId: text('source_occurrence_id').notNull(),
    sourceRevision: bigint('source_revision', { mode: 'number' }).notNull(),
    sourceSystem: text('source_system').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('payment_observations_scope_id_uk').on(table.tenantId, table.legalEntityId, table.observationId),
    unique('payment_observations_occurrence_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceKind,
      table.sourceSystem,
      table.accountRef,
      table.environment,
      table.sourceOccurrenceId,
      table.sourceRevision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.sourceAuthorityId],
      foreignColumns: [
        sourceAuthorities.tenantId,
        sourceAuthorities.legalEntityId,
        sourceAuthorities.sourceAuthorityId,
      ],
      name: 'payment_observations_authority_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.legalEntityId, payments.paymentId],
      name: 'payment_observations_payment_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.operationId],
      foreignColumns: [
        paymentOperations.tenantId,
        paymentOperations.legalEntityId,
        paymentOperations.paymentId,
        paymentOperations.operationId,
      ],
      name: 'payment_observations_operation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.correctsObservationId],
      foreignColumns: [table.tenantId, table.legalEntityId, table.observationId],
      name: 'payment_observations_corrects_fk',
    }).onDelete('restrict'),
    index('payment_observations_payment_idx').on(table.tenantId, table.legalEntityId, table.paymentId),
    index('payment_observations_effect_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.operationId,
      table.economicEffectKey,
    ),
    check(
      'payment_observations_correction_effect_ck',
      sql`(${table.correctionEffect} is not null) = (${table.factKind} = 'SOURCE_CORRECTION' and ${table.acceptanceOutcome} = 'ACCEPTED_OBSERVATION') and (${table.correctionEffect} is null or ${table.correctionEffect} in (${literalList(PAYMENT_CORRECTION_EFFECTS)}))`,
    ),
    check(
      'payment_observations_vocabulary_ck',
      sql`${table.acceptanceOutcome} in (${literalList(PAYMENT_OBSERVATION_ACCEPTANCE_OUTCOMES)}) and ${table.factKind} in (${literalList(PAYMENT_OBSERVATION_FACT_KINDS)}) and ${table.factFamily} in (${literalList(PAYMENT_SOURCE_FACT_FAMILIES)}) and ${table.sourceKind} in (${literalList(PAYMENT_SOURCE_KINDS)})`,
    ),
    check(
      'payment_observations_money_ck',
      sql`(${table.amountMinor} is null) = (${table.currency} is null) and (${table.amountMinor} is null or (${table.amountMinor} between 0 and ${maximumAmountMinor} and ${table.currency} = ${launchCurrency}))`,
    ),
    check(
      'payment_observations_correlation_ck',
      sql`(${table.operationId} is null or ${table.paymentId} is not null) and (${table.correctsObservationId} is null or ${table.correctsObservationId} <> ${table.observationId})`,
    ),
    check(
      'payment_observations_authority_ck',
      sql`(${table.sourceAuthorityId} is null) = (${table.sourceAuthorityRevision} is null) and (${table.sourceAuthorityRevision} is null or ${table.sourceAuthorityRevision} > 0) and (${table.acceptanceOutcome} = 'UNAUTHORIZED_SOURCE' or ${table.sourceAuthorityId} is not null)`,
    ),
    check('payment_observations_revision_ck', sql`${table.sourceRevision} between 0 and ${maximumAmountMinor}`),
    check('payment_observations_times_ck', sql`${table.verifiedAt} >= ${table.receivedAt}`),
    opaqueCheck('payment_observations_system_ck', table.sourceSystem),
    opaqueCheck('payment_observations_account_ck', table.accountRef),
    opaqueCheck('payment_observations_environment_ck', table.environment),
    opaqueCheck('payment_observations_occurrence_ck', table.sourceOccurrenceId),
    check(
      'payment_observations_refs_ck',
      sql`(${table.economicEffectKey} is null or (${table.economicEffectKey} = btrim(${table.economicEffectKey}) and length(${table.economicEffectKey}) between 1 and 200)) and (${table.evidenceRef} is null or (${table.evidenceRef} = btrim(${table.evidenceRef}) and length(${table.evidenceRef}) between 1 and 200))`,
    ),
    compositionRevisionCheck('payment_observations_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_observations', table.tenantId, table.legalEntityId),
  ],
);

/** Immutable Payment Authorization proof for one exact Order Commitment Attempt (#1149). */
export const paymentAuthorizations = paymentSchema.table.withRLS(
  'payment_authorizations',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    authorizationId: uuid('authorization_id').defaultRandom().primaryKey(),
    coverageRevision: integer('coverage_revision'),
    currency: text('currency').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuanceKey: text('issuance_key').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    method: text('method').$type<PaymentMethod>().notNull(),
    methodConditionEvidence: jsonb('method_condition_evidence').$type<Schema.Json>(),
    orderCommitmentAttemptId: text('order_commitment_attempt_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    paymentTermRef: jsonb('payment_term_ref').$type<Schema.Json>().notNull(),
    proofKind: text('proof_kind').$type<PaymentAuthorizationProofKind>().notNull(),
    purchaseCorrelationId: text('purchase_correlation_id').notNull(),
  },
  (table) => [
    unique('payment_authorizations_scope_id_uk').on(table.tenantId, table.legalEntityId, table.authorizationId),
    unique('payment_authorizations_issuance_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.paymentId,
      table.orderCommitmentAttemptId,
      table.issuanceKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.legalEntityId, payments.paymentId],
      name: 'payment_authorizations_payment_fk',
    }).onDelete('restrict'),
    check(
      'payment_authorizations_proof_ck',
      sql`${table.proofKind} in (${literalList(PAYMENT_AUTHORIZATION_PROOF_KINDS)}) and (${table.proofKind} <> 'PREPAID_COVERAGE' or (${table.coverageRevision} is not null and ${table.coverageRevision} > 0)) and (${table.proofKind} <> 'METHOD_CONDITION' or jsonb_typeof(${table.methodConditionEvidence}) = 'object')`,
    ),
    check(
      'payment_authorizations_amount_ck',
      sql`${table.amountMinor} between 0 and ${maximumAmountMinor} and ${table.currency} = ${launchCurrency}`,
    ),
    check('payment_authorizations_method_ck', sql`${table.method} in (${literalList(PAYMENT_METHODS)})`),
    check('payment_authorizations_validity_ck', sql`${table.expiresAt} > ${table.issuedAt}`),
    check('payment_authorizations_issuance_key_ck', sql`${table.issuanceKey} ~ '^[!-~]{1,200}$'`),
    opaqueCheck('payment_authorizations_attempt_ck', table.orderCommitmentAttemptId),
    opaqueCheck('payment_authorizations_purchase_ck', table.purchaseCorrelationId),
    compositionRevisionCheck('payment_authorizations_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_authorizations', table.tenantId, table.legalEntityId),
  ],
);

/** Append-only governed recovery request of one original operation and its stored binding (#1151). */
export const recoveryRequests = paymentSchema.table.withRLS(
  'recovery_requests',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    bindingSnapshot: jsonb('binding_snapshot').$type<Schema.Json>().notNull(),
    mode: text('mode').$type<PaymentRecoveryMode>().notNull(),
    operationId: uuid('operation_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    reason: text('reason').notNull(),
    recoveryId: uuid('recovery_id').defaultRandom().primaryKey(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('payment_recovery_requests_scope_id_uk').on(table.tenantId, table.legalEntityId, table.recoveryId),
    unique('payment_recovery_requests_invocation_uk').on(table.tenantId, table.legalEntityId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.operationId],
      foreignColumns: [
        paymentOperations.tenantId,
        paymentOperations.legalEntityId,
        paymentOperations.paymentId,
        paymentOperations.operationId,
      ],
      name: 'payment_recovery_requests_operation_fk',
    }).onDelete('restrict'),
    check('payment_recovery_requests_mode_ck', sql`${table.mode} in (${literalList(PAYMENT_RECOVERY_MODES)})`),
    check('payment_recovery_requests_binding_ck', sql`jsonb_typeof(${table.bindingSnapshot}) = 'object'`),
    reasonCheck('payment_recovery_requests_reason_ck', table.reason),
    compositionRevisionCheck('payment_recovery_requests_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_recovery_requests', table.tenantId, table.legalEntityId),
  ],
);

/** Held, ambiguous or conflicting evidence/operations awaiting governed reconciliation (#1151). */
export const reconciliationCases = paymentSchema.table.withRLS(
  'reconciliation_cases',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    caseId: uuid('case_id').defaultRandom().primaryKey(),
    caseKind: text('case_kind').$type<PaymentReconciliationCaseKind>().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    observationId: uuid('observation_id'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    operationId: uuid('operation_id'),
    paymentId: uuid('payment_id'),
    revision: integer('revision').notNull(),
    status: text('status').$type<PaymentReconciliationCaseStatus>().notNull(),
  },
  (table) => [
    unique('payment_reconciliation_cases_scope_id_uk').on(table.tenantId, table.legalEntityId, table.caseId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId],
      foreignColumns: [payments.tenantId, payments.legalEntityId, payments.paymentId],
      name: 'payment_reconciliation_cases_payment_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.operationId],
      foreignColumns: [
        paymentOperations.tenantId,
        paymentOperations.legalEntityId,
        paymentOperations.paymentId,
        paymentOperations.operationId,
      ],
      name: 'payment_reconciliation_cases_operation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.observationId],
      foreignColumns: [observations.tenantId, observations.legalEntityId, observations.observationId],
      name: 'payment_reconciliation_cases_observation_fk',
    }).onDelete('restrict'),
    index('payment_reconciliation_cases_open_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.status,
      table.paymentId,
    ),
    check(
      'payment_reconciliation_cases_kind_ck',
      sql`${table.caseKind} in (${literalList(PAYMENT_RECONCILIATION_CASE_KINDS)}) and ${table.status} in (${literalList(PAYMENT_RECONCILIATION_CASE_STATUSES)})`,
    ),
    check(
      'payment_reconciliation_cases_subject_ck',
      sql`(${table.paymentId} is not null or ${table.observationId} is not null) and (${table.operationId} is null or ${table.paymentId} is not null)`,
    ),
    check(
      'payment_reconciliation_cases_status_ck',
      sql`(${table.status} = 'CLOSED') = (${table.closedAt} is not null) and ${table.revision} > 0`,
    ),
    compositionRevisionCheck('payment_reconciliation_cases_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_reconciliation_cases', table.tenantId, table.legalEntityId),
  ],
);

/** Append-only audited reconciliation decisions; they never fabricate money. */
export const reconciliationDecisions = paymentSchema.table.withRLS(
  'reconciliation_decisions',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    caseId: uuid('case_id').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    decisionId: uuid('decision_id').defaultRandom().primaryKey(),
    decisionKind: text('decision_kind').$type<PaymentReconciliationDecisionKind>().notNull(),
    evidenceRef: text('evidence_ref'),
    reason: text('reason').notNull(),
    resultingOutcome: text('resulting_outcome').$type<PaymentOperationOutcome>(),
  },
  (table) => [
    unique('payment_reconciliation_decisions_scope_id_uk').on(table.tenantId, table.legalEntityId, table.decisionId),
    unique('payment_reconciliation_decisions_invocation_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.actionInvocationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.caseId],
      foreignColumns: [reconciliationCases.tenantId, reconciliationCases.legalEntityId, reconciliationCases.caseId],
      name: 'payment_reconciliation_decisions_case_fk',
    }).onDelete('restrict'),
    check(
      'payment_reconciliation_decisions_kind_ck',
      sql`${table.decisionKind} in (${literalList(PAYMENT_RECONCILIATION_DECISION_KINDS)}) and (${table.resultingOutcome} is null or ${table.resultingOutcome} in (${literalList(PAYMENT_OPERATION_OUTCOMES)}))`,
    ),
    check(
      'payment_reconciliation_decisions_evidence_ck',
      sql`${table.evidenceRef} is null or (${table.evidenceRef} = btrim(${table.evidenceRef}) and length(${table.evidenceRef}) between 1 and 200)`,
    ),
    reasonCheck('payment_reconciliation_decisions_reason_ck', table.reason),
    compositionRevisionCheck('payment_reconciliation_decisions_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_reconciliation_decisions', table.tenantId, table.legalEntityId),
  ],
);

export const PAYMENT_TABLES = [
  gatewayAssertionRedemptions,
  methodEnablements,
  methodEnablementRevisions,
  sourceAuthorities,
  sourceAuthorityRevisions,
  payments,
  paymentOperations,
  operationOutcomeTransitions,
  refundItemClaims,
  observations,
  paymentAuthorizations,
  recoveryRequests,
  reconciliationCases,
  reconciliationDecisions,
] as const;

export const PAYMENT_TABLE_INVENTORY = [
  'gateway_assertion_redemptions',
  'method_enablement_revisions',
  'method_enablements',
  'observations',
  'operation_outcome_transitions',
  'payment_authorizations',
  'payment_operations',
  'payments',
  'reconciliation_cases',
  'reconciliation_decisions',
  'recovery_requests',
  'refund_item_claims',
  'source_authorities',
  'source_authority_revisions',
] as const;

/** Relational Queries v2 entry point for this owner. */
export const paymentRelations = defineRelations({
  gatewayAssertionRedemptions,
  methodEnablementRevisions,
  methodEnablements,
  observations,
  operationOutcomeTransitions,
  paymentAuthorizations,
  paymentOperations,
  payments,
  reconciliationCases,
  reconciliationDecisions,
  recoveryRequests,
  refundItemClaims,
  sourceAuthorities,
  sourceAuthorityRevisions,
});
