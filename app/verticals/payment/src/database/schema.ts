import { tenantLegalEntityRlsPolicies, tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  bytea,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
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
  PAYMENT_GATEWAY_PROVIDER_FAMILIES,
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
  PaymentGatewayProviderFamilySchema,
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
import {
  GATEWAY_BINDING_STATUSES,
  GATEWAY_CREDENTIAL_STATUSES,
  GATEWAY_ENVIRONMENTS,
  PROVIDER_DISPATCH_STATES,
  PROVIDER_EVIDENCE_FACT_KINDS,
  PROVIDER_EVIDENCE_ORIGINS,
  PROVIDER_EVIDENCE_SUBMISSION_STATES,
  PROVIDER_NOT_SENT_REASONS,
  PROVIDER_NOTIFICATION_AUTHENTICITY,
  PROVIDER_NOTIFICATION_STATES,
} from '../../shared/domain/psp-vocabulary.ts';
import type {
  GatewayBindingStatus,
  GatewayCredentialStatus,
  GatewayEnvironment,
  ProviderDispatchState,
  ProviderEvidenceFactKind,
  ProviderEvidenceOrigin,
  ProviderEvidenceSubmissionState,
  ProviderNotificationAuthenticity,
  ProviderNotificationState,
  ProviderNotSentReason,
} from '../../shared/domain/psp-vocabulary.ts';

type PaymentGatewayProviderFamily = typeof PaymentGatewayProviderFamilySchema.Type;

export const PAYMENT_SCHEMA_NAME = 'payment';
export const paymentSchema = pgSchema(PAYMENT_SCHEMA_NAME);

/** Constant vocabulary rendered once into CHECK constraints; never caller data. */
const literalList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '));
const maximumAmountMinor = sql.raw(String(Number.MAX_SAFE_INTEGER));
const launchCurrency = sql.raw(`'${PAYMENT_LAUNCH_CURRENCY}'`);
/** Sources that speak for a Payment only through its exact selected capability (#1152). */
const SELECTED_CAPABILITY_SOURCE_KINDS = [
  'CARRIER',
  'LOCAL_POS_OPERATOR',
] as const satisfies readonly PaymentSourceKind[];

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
    pickupCapabilityRef: text('pickup_capability_ref'),
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
        table.pickupCapabilityRef,
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
    check(
      'payment_source_authorities_pickup_capability_ck',
      sql`${table.pickupCapabilityRef} is null or (${table.sourceKind} = 'LOCAL_POS_OPERATOR'
        and ${table.pickupCapabilityRef} = btrim(${table.pickupCapabilityRef})
        and length(${table.pickupCapabilityRef}) between 1 and 200)`,
    ),
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
    /**
     * Selected-capability sources of a Payment only (#1152): whether qualification proved the statement
     * names the exact selected Delivery Offer / pickup capability. Null for other sources and unassigned evidence.
     */
    capabilityCorrelated: boolean('capability_correlated'),
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
    /** SHA-256 of the statement exactly as its source claimed it; compared on occurrence replays. */
    statementHash: text('statement_hash').notNull(),
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
      'payment_observations_capability_ck',
      sql`${table.capabilityCorrelated} is null or (${table.paymentId} is not null and ${table.sourceKind} in (${literalList(SELECTED_CAPABILITY_SOURCE_KINDS)}))`,
    ),
    check('payment_observations_statement_hash_ck', sql`${table.statementHash} ~ '^[0-9a-f]{64}$'`),
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

/**
 * Append-only attribution of one confirmed source economic effect to the one Payment Operation it
 * established (#1151 "Several observations proven to describe the same economic effect count once"),
 * across every Payment of the trusted Tenant / Selling Legal Entity. The key is the source binding
 * (whichever of its authority records qualified the statement), the fact and the source's own effect
 * key. The first statement or governed attachment that establishes the effect appends the row inside
 * its Action transaction; the unique key serializes concurrent first attributions, and the provenance
 * names the establishing invocation (its observation or reconciliation decision row).
 */
export const economicEffectAttributions = paymentSchema.table.withRLS(
  'economic_effect_attributions',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    accountRef: text('account_ref').notNull(),
    attributedAt: timestamp('attributed_at', { withTimezone: true }).notNull(),
    attributionId: uuid('attribution_id').defaultRandom().primaryKey(),
    economicEffectKey: text('economic_effect_key').notNull(),
    environment: text('environment').notNull(),
    factKind: text('fact_kind').$type<PaymentObservationFactKind>().notNull(),
    operationId: uuid('operation_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    sourceKind: text('source_kind').$type<PaymentSourceKind>().notNull(),
    sourceSystem: text('source_system').notNull(),
  },
  (table) => [
    unique('payment_economic_effect_attributions_effect_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.sourceKind,
      table.sourceSystem,
      table.accountRef,
      table.environment,
      table.factKind,
      table.economicEffectKey,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.operationId],
      foreignColumns: [
        paymentOperations.tenantId,
        paymentOperations.legalEntityId,
        paymentOperations.paymentId,
        paymentOperations.operationId,
      ],
      name: 'payment_economic_effect_attributions_operation_fk',
    }).onDelete('restrict'),
    check(
      'payment_economic_effect_attributions_vocabulary_ck',
      sql`${table.factKind} in (${literalList(PAYMENT_OBSERVATION_FACT_KINDS)}) and ${table.sourceKind} in (${literalList(PAYMENT_SOURCE_KINDS)})`,
    ),
    opaqueCheck('payment_economic_effect_attributions_system_ck', table.sourceSystem),
    opaqueCheck('payment_economic_effect_attributions_account_ck', table.accountRef),
    opaqueCheck('payment_economic_effect_attributions_environment_ck', table.environment),
    opaqueCheck('payment_economic_effect_attributions_effect_ck', table.economicEffectKey),
    compositionRevisionCheck('payment_economic_effect_attributions_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_economic_effect_attributions', table.tenantId, table.legalEntityId),
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
    /** Recovery rounds and the last request instant of one operation (gateway reconciliation due listing). */
    index('payment_recovery_requests_operation_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.operationId,
      table.requestedAt,
    ),
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
    /** The operation an ATTACH_EVIDENCE decision counted its evidence toward, when it named or had one. */
    operationId: uuid('operation_id'),
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

/*
 * C17 provider gateway tables (#1155-#1158). Action-written rows carry `provenanceColumns()`. Worker-written
 * rows (dispatches, evidence, notification processing) are written only by SECURITY DEFINER scoped routines
 * and carry origin columns instead: a reference to the admitting invocation, never a human actor.
 */
const gatewayFamilyCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} in (${literalList(PAYMENT_GATEWAY_PROVIDER_FAMILIES)})`);
const gatewayEnvironmentCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} in (${literalList(GATEWAY_ENVIRONMENTS)})`);
const httpsUrlCheck = (name: string, column: AnyPgColumn) =>
  check(
    name,
    sql`${column} is null or (${column} ~ '^https://[^[:space:]/?#]+[^[:space:]]*$' and length(${column}) <= 2000)`,
  );
const accountRefCheck = (name: string, column: AnyPgColumn) => check(name, sql`${column} ~ '^pab_[0-9a-f]{32}$'`);
const providerRefCheck = (name: string, column: AnyPgColumn) =>
  check(name, sql`${column} is null or (${column} = btrim(${column}) and length(${column}) between 1 and 200)`);
/** Opaque request bytes and raw notification bodies are bounded at 64 KiB. */
const MAXIMUM_OPAQUE_BYTES = sql.raw(String(64 * 1024));

/** Origin of a worker-written row: the admitting invocation (a reference, not an actor) and the delivery. */
const workerOriginColumns = () => ({
  deliveryId: uuid('delivery_id').notNull(),
  originActionInvocationId: uuid('origin_action_invocation_id').notNull(),
  originCompositionRevision: text('origin_composition_revision').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  workerKey: text('worker_key').notNull(),
});

/** Current Provider Account Binding (#1155). Identity columns are insert-once; status only retires. */
export const pspProviderAccountBindings = paymentSchema.table.withRLS(
  'psp_provider_account_bindings',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    bindingId: uuid('binding_id').defaultRandom().primaryKey(),
    configuredAt: timestamp('configured_at', { withTimezone: true }).notNull(),
    currentCredentialRevision: integer('current_credential_revision').notNull(),
    environment: text('environment').$type<GatewayEnvironment>().notNull(),
    merchantIdentity: jsonb('merchant_identity').$type<Schema.Json>().notNull(),
    notificationUrl: text('notification_url').notNull(),
    providerAccountRef: text('provider_account_ref').notNull(),
    providerFamily: text('provider_family').$type<PaymentGatewayProviderFamily>().notNull(),
    reason: text('reason').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').$type<GatewayBindingStatus>().notNull(),
  },
  (table) => [
    unique('payment_psp_bindings_scope_id_uk').on(table.tenantId, table.legalEntityId, table.bindingId),
    unique('payment_psp_bindings_family_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingId,
      table.providerFamily,
      table.environment,
    ),
    unique('payment_psp_bindings_account_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingId,
      table.providerFamily,
      table.environment,
      table.providerAccountRef,
    ),
    unique('payment_psp_bindings_ref_uk').on(table.tenantId, table.providerAccountRef),
    uniqueIndex('payment_psp_bindings_current_uk')
      .on(table.tenantId, table.legalEntityId, table.providerFamily, table.environment)
      .where(sql`${table.status} = 'CURRENT'`),
    gatewayFamilyCheck('payment_psp_bindings_family_ck', table.providerFamily),
    gatewayEnvironmentCheck('payment_psp_bindings_environment_ck', table.environment),
    check('payment_psp_bindings_status_ck', sql`${table.status} in (${literalList(GATEWAY_BINDING_STATUSES)})`),
    check(
      'payment_psp_bindings_merchant_ck',
      sql`jsonb_typeof(${table.merchantIdentity}) = 'object' and ${table.merchantIdentity}->>'_tag' = ${table.providerFamily}`,
    ),
    check('payment_psp_bindings_revisions_ck', sql`${table.revision} > 0 and ${table.currentCredentialRevision} > 0`),
    accountRefCheck('payment_psp_bindings_ref_ck', table.providerAccountRef),
    httpsUrlCheck('payment_psp_bindings_notification_url_ck', table.notificationUrl),
    reasonCheck('payment_psp_bindings_reason_ck', table.reason),
    compositionRevisionCheck('payment_psp_bindings_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_psp_provider_account_bindings', table.tenantId, table.legalEntityId),
  ],
);

/** Append-only history of every Provider Account Binding revision. */
export const pspProviderAccountBindingRevisions = paymentSchema.table.withRLS(
  'psp_provider_account_binding_revisions',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    bindingId: uuid('binding_id').notNull(),
    bindingRevisionId: uuid('binding_revision_id').defaultRandom().primaryKey(),
    currentCredentialRevision: integer('current_credential_revision').notNull(),
    notificationUrl: text('notification_url').notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    revision: integer('revision').notNull(),
    status: text('status').$type<GatewayBindingStatus>().notNull(),
  },
  (table) => [
    unique('payment_psp_binding_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.bindingId],
      foreignColumns: [
        pspProviderAccountBindings.tenantId,
        pspProviderAccountBindings.legalEntityId,
        pspProviderAccountBindings.bindingId,
      ],
      name: 'payment_psp_binding_revisions_binding_fk',
    }).onDelete('restrict'),
    check(
      'payment_psp_binding_revisions_status_ck',
      sql`${table.status} in (${literalList(GATEWAY_BINDING_STATUSES)})`,
    ),
    check(
      'payment_psp_binding_revisions_revisions_ck',
      sql`${table.revision} > 0 and ${table.currentCredentialRevision} > 0`,
    ),
    httpsUrlCheck('payment_psp_binding_revisions_notification_url_ck', table.notificationUrl),
    reasonCheck('payment_psp_binding_revisions_reason_ck', table.reason),
    compositionRevisionCheck('payment_psp_binding_revisions_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies(
      'payment_psp_provider_account_binding_revisions',
      table.tenantId,
      table.legalEntityId,
    ),
  ],
);

/**
 * Credential revisions of one binding (#1155). Only an opaque `secret_ref` names the material; it is never
 * selected into a business projection. A revision only moves ACTIVE -> RETIRED.
 */
export const pspCredentialRevisions = paymentSchema.table.withRLS(
  'psp_credential_revisions',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    bindingId: uuid('binding_id').notNull(),
    credentialRevisionId: uuid('credential_revision_id').defaultRandom().primaryKey(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    retiredByActionInvocationId: uuid('retired_by_action_invocation_id'),
    revision: integer('revision').notNull(),
    secretRef: text('secret_ref').notNull(),
    status: text('status').$type<GatewayCredentialStatus>().notNull(),
  },
  (table) => [
    unique('payment_psp_credentials_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingId,
      table.revision,
    ),
    uniqueIndex('payment_psp_credentials_active_uk')
      .on(table.tenantId, table.legalEntityId, table.bindingId)
      .where(sql`${table.status} = 'ACTIVE'`),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.bindingId],
      foreignColumns: [
        pspProviderAccountBindings.tenantId,
        pspProviderAccountBindings.legalEntityId,
        pspProviderAccountBindings.bindingId,
      ],
      name: 'payment_psp_credentials_binding_fk',
    }).onDelete('restrict'),
    check('payment_psp_credentials_status_ck', sql`${table.status} in (${literalList(GATEWAY_CREDENTIAL_STATUSES)})`),
    check('payment_psp_credentials_revision_ck', sql`${table.revision} > 0`),
    check('payment_psp_credentials_secret_ref_ck', sql`${table.secretRef} ~ '^[A-Za-z0-9._-]{1,120}$'`),
    check(
      'payment_psp_credentials_retirement_ck',
      sql`(${table.status} = 'RETIRED') = (${table.retiredAt} is not null) and (${table.retiredAt} is null) = (${table.retiredByActionInvocationId} is null)`,
    ),
    compositionRevisionCheck('payment_psp_credentials_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_psp_credential_revisions', table.tenantId, table.legalEntityId),
  ],
);

/** Current Gateway Enablement per Customer Configuration, Selling Legal Entity and family (#1155). */
export const pspGatewayEnablements = paymentSchema.table.withRLS(
  'psp_gateway_enablements',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    bindingId: uuid('binding_id').notNull(),
    configuredAt: timestamp('configured_at', { withTimezone: true }).notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    enabled: boolean('enabled').notNull(),
    enablementId: uuid('enablement_id').defaultRandom().primaryKey(),
    environment: text('environment').$type<GatewayEnvironment>().notNull(),
    providerFamily: text('provider_family').$type<PaymentGatewayProviderFamily>().notNull(),
    reason: text('reason').notNull(),
    returnUrl: text('return_url').notNull(),
    revision: integer('revision').notNull(),
  },
  (table) => [
    unique('payment_psp_enablements_scope_id_uk').on(table.tenantId, table.legalEntityId, table.enablementId),
    unique('payment_psp_enablements_identity_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.customerConfigurationId,
      table.providerFamily,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.bindingId, table.providerFamily, table.environment],
      foreignColumns: [
        pspProviderAccountBindings.tenantId,
        pspProviderAccountBindings.legalEntityId,
        pspProviderAccountBindings.bindingId,
        pspProviderAccountBindings.providerFamily,
        pspProviderAccountBindings.environment,
      ],
      name: 'payment_psp_enablements_binding_fk',
    }).onDelete('restrict'),
    gatewayFamilyCheck('payment_psp_enablements_family_ck', table.providerFamily),
    gatewayEnvironmentCheck('payment_psp_enablements_environment_ck', table.environment),
    check('payment_psp_enablements_revision_ck', sql`${table.revision} > 0`),
    httpsUrlCheck('payment_psp_enablements_return_url_ck', table.returnUrl),
    opaqueCheck('payment_psp_enablements_configuration_ck', table.customerConfigurationId),
    reasonCheck('payment_psp_enablements_reason_ck', table.reason),
    compositionRevisionCheck('payment_psp_enablements_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_psp_gateway_enablements', table.tenantId, table.legalEntityId),
  ],
);

/** Append-only history of every Gateway Enablement revision. */
export const pspGatewayEnablementRevisions = paymentSchema.table.withRLS(
  'psp_gateway_enablement_revisions',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    bindingId: uuid('binding_id').notNull(),
    customerConfigurationId: text('customer_configuration_id').notNull(),
    enabled: boolean('enabled').notNull(),
    enablementId: uuid('enablement_id').notNull(),
    enablementRevisionId: uuid('enablement_revision_id').defaultRandom().primaryKey(),
    environment: text('environment').$type<GatewayEnvironment>().notNull(),
    providerFamily: text('provider_family').$type<PaymentGatewayProviderFamily>().notNull(),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    returnUrl: text('return_url').notNull(),
    revision: integer('revision').notNull(),
  },
  (table) => [
    unique('payment_psp_enablement_revisions_number_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.enablementId,
      table.revision,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.enablementId],
      foreignColumns: [
        pspGatewayEnablements.tenantId,
        pspGatewayEnablements.legalEntityId,
        pspGatewayEnablements.enablementId,
      ],
      name: 'payment_psp_enablement_revisions_current_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.bindingId, table.providerFamily, table.environment],
      foreignColumns: [
        pspProviderAccountBindings.tenantId,
        pspProviderAccountBindings.legalEntityId,
        pspProviderAccountBindings.bindingId,
        pspProviderAccountBindings.providerFamily,
        pspProviderAccountBindings.environment,
      ],
      name: 'payment_psp_enablement_revisions_binding_fk',
    }).onDelete('restrict'),
    gatewayFamilyCheck('payment_psp_enablement_revisions_family_ck', table.providerFamily),
    gatewayEnvironmentCheck('payment_psp_enablement_revisions_environment_ck', table.environment),
    check('payment_psp_enablement_revisions_revision_ck', sql`${table.revision} > 0`),
    httpsUrlCheck('payment_psp_enablement_revisions_return_url_ck', table.returnUrl),
    opaqueCheck('payment_psp_enablement_revisions_configuration_ck', table.customerConfigurationId),
    reasonCheck('payment_psp_enablement_revisions_reason_ck', table.reason),
    compositionRevisionCheck('payment_psp_enablement_revisions_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_psp_gateway_enablement_revisions', table.tenantId, table.legalEntityId),
  ],
);

/**
 * Provider dispatch ledger (#1156/#1158): one row per Payment Operation, persisted before the first send.
 * Identity and material columns are immutable; `state` follows the guarded transition graph.
 */
export const pspProviderDispatches = paymentSchema.table.withRLS(
  'psp_provider_dispatches',
  {
    ...scopeColumns(),
    ...workerOriginColumns(),
    bindingId: uuid('binding_id').notNull(),
    credentialRevision: integer('credential_revision'),
    customerRedirectUrl: text('customer_redirect_url'),
    dispatchId: uuid('dispatch_id').defaultRandom().primaryKey(),
    endpointRef: text('endpoint_ref'),
    environment: text('environment').$type<GatewayEnvironment>().notNull(),
    idempotencyKeyHash: text('idempotency_key_hash'),
    /** The C16 operation-requested materialHash (plan D13). */
    materialHash: text('material_hash').notNull(),
    notSentReason: text('not_sent_reason').$type<ProviderNotSentReason>(),
    operationId: uuid('operation_id').notNull(),
    operationKind: text('operation_kind').$type<PaymentOperationKind>().notNull(),
    orderReference: text('order_reference').notNull(),
    paymentId: uuid('payment_id').notNull(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    providerAccountRef: text('provider_account_ref').notNull(),
    providerFamily: text('provider_family').$type<PaymentGatewayProviderFamily>().notNull(),
    providerPaymentRef: text('provider_payment_ref'),
    providerRefundRef: text('provider_refund_ref'),
    replayExpiresAt: timestamp('replay_expires_at', { withTimezone: true }),
    replayStartsAt: timestamp('replay_starts_at', { withTimezone: true }),
    /**
     * Opaque request bytes for an exact Stripe replay; never contains a secret. Empty for a body-less POST (the
     * Checkout Session `/expire`): `request_hash` still binds the endpoint, the headers and the idempotency key.
     */
    requestBody: bytea('request_body'),
    requestHash: text('request_hash'),
    /** Non-secret request headers covered by `request_hash`, persisted with the replay body. */
    requestHeaders: jsonb('request_headers').$type<Schema.Json>(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    returnToken: text('return_token'),
    state: text('state').$type<ProviderDispatchState>().notNull(),
    targetOperationId: uuid('target_operation_id'),
    transitionDeliveryId: uuid('transition_delivery_id'),
    transitionedAt: timestamp('transitioned_at', { withTimezone: true }),
  },
  (table) => [
    unique('payment_psp_dispatches_operation_uk').on(table.tenantId, table.legalEntityId, table.operationId),
    unique('payment_psp_dispatches_order_reference_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingId,
      table.orderReference,
    ),
    uniqueIndex('payment_psp_dispatches_return_token_uk')
      .on(table.tenantId, table.legalEntityId, table.returnToken)
      .where(sql`${table.returnToken} is not null`),
    index('payment_psp_dispatches_target_idx').on(table.tenantId, table.legalEntityId, table.targetOperationId),
    index('payment_psp_dispatches_provider_payment_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingId,
      table.providerPaymentRef,
    ),
    index('payment_psp_dispatches_state_idx').on(table.tenantId, table.legalEntityId, table.state),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.operationId],
      foreignColumns: [
        paymentOperations.tenantId,
        paymentOperations.legalEntityId,
        paymentOperations.paymentId,
        paymentOperations.operationId,
      ],
      name: 'payment_psp_dispatches_operation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.targetOperationId],
      foreignColumns: [
        paymentOperations.tenantId,
        paymentOperations.legalEntityId,
        paymentOperations.paymentId,
        paymentOperations.operationId,
      ],
      name: 'payment_psp_dispatches_target_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.bindingId,
        table.providerFamily,
        table.environment,
        table.providerAccountRef,
      ],
      foreignColumns: [
        pspProviderAccountBindings.tenantId,
        pspProviderAccountBindings.legalEntityId,
        pspProviderAccountBindings.bindingId,
        pspProviderAccountBindings.providerFamily,
        pspProviderAccountBindings.environment,
        pspProviderAccountBindings.providerAccountRef,
      ],
      name: 'payment_psp_dispatches_binding_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.bindingId, table.credentialRevision],
      foreignColumns: [
        pspCredentialRevisions.tenantId,
        pspCredentialRevisions.legalEntityId,
        pspCredentialRevisions.bindingId,
        pspCredentialRevisions.revision,
      ],
      name: 'payment_psp_dispatches_credential_fk',
    }).onDelete('restrict'),
    check(
      'payment_psp_dispatches_vocabulary_ck',
      sql`${table.state} in (${literalList(PROVIDER_DISPATCH_STATES)}) and ${table.operationKind} in (${literalList(PAYMENT_OPERATION_KINDS)}) and (${table.notSentReason} is null or ${table.notSentReason} in (${literalList(PROVIDER_NOT_SENT_REASONS)}))`,
    ),
    gatewayFamilyCheck('payment_psp_dispatches_family_ck', table.providerFamily),
    gatewayEnvironmentCheck('payment_psp_dispatches_environment_ck', table.environment),
    check(
      'payment_psp_dispatches_target_ck',
      sql`(${table.operationKind} = 'COLLECT') = (${table.targetOperationId} is null) and (${table.targetOperationId} is null or ${table.targetOperationId} <> ${table.operationId})`,
    ),
    check(
      'payment_psp_dispatches_order_reference_ck',
      sql`${table.orderReference} = replace(${table.operationId}::text, '-', '')`,
    ),
    check(
      'payment_psp_dispatches_not_sent_ck',
      sql`(${table.state} = 'NOT_SENT') = (${table.notSentReason} is not null)`,
    ),
    check(
      'payment_psp_dispatches_request_ck',
      sql`(${table.preparedAt} is null) = (${table.requestHash} is null)
        and (${table.preparedAt} is null) = (${table.endpointRef} is null)
        and (${table.preparedAt} is null) = (${table.credentialRevision} is null)
        and (${table.state} not in ('PREPARED', 'ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT', 'OUTCOME_UNKNOWN') or ${table.preparedAt} is not null)
        and (${table.state} not in ('AWAITING_TARGET', 'NOT_SENT', 'UNSUPPORTED', 'TARGET_UNRESOLVED') or ${table.preparedAt} is null)
        and (${table.idempotencyKeyHash} is null or ${table.preparedAt} is not null)
        and (${table.requestBody} is null or (${table.preparedAt} is not null and octet_length(${table.requestBody}) <= ${MAXIMUM_OPAQUE_BYTES}))
        and (${table.requestBody} is null) = (${table.requestHeaders} is null)
        and (${table.requestHeaders} is null or jsonb_typeof(${table.requestHeaders}) = 'array')`,
    ),
    check(
      'payment_psp_dispatches_replay_ck',
      sql`(${table.replayStartsAt} is null) = (${table.replayExpiresAt} is null)
        and (${table.replayStartsAt} is null or (${table.replayExpiresAt} > ${table.replayStartsAt}
          and ${table.idempotencyKeyHash} is not null and ${table.requestBody} is not null))`,
    ),
    check(
      'payment_psp_dispatches_return_token_ck',
      sql`${table.returnToken} is null or (${table.operationKind} = 'COLLECT' and ${table.returnToken} ~ '^[A-Za-z0-9_-]{22}$')`,
    ),
    check(
      'payment_psp_dispatches_credential_revision_ck',
      sql`${table.credentialRevision} is null or ${table.credentialRevision} > 0`,
    ),
    check(
      'payment_psp_dispatches_response_ck',
      sql`(${table.respondedAt} is not null) = (${table.state} in ('ACKNOWLEDGED', 'REJECTED_BEFORE_EFFECT', 'OUTCOME_UNKNOWN'))
        and (${table.customerRedirectUrl} is null or ${table.state} = 'ACKNOWLEDGED')
        and (${table.transitionedAt} is null) = (${table.transitionDeliveryId} is null)`,
    ),
    check(
      'payment_psp_dispatches_hashes_ck',
      sql`${table.materialHash} ~ '^[a-f0-9]{64}$' and (${table.requestHash} is null or ${table.requestHash} ~ '^[a-f0-9]{64}$') and (${table.idempotencyKeyHash} is null or ${table.idempotencyKeyHash} ~ '^[a-f0-9]{64}$')`,
    ),
    httpsUrlCheck('payment_psp_dispatches_redirect_ck', table.customerRedirectUrl),
    accountRefCheck('payment_psp_dispatches_ref_ck', table.providerAccountRef),
    providerRefCheck('payment_psp_dispatches_endpoint_ck', table.endpointRef),
    providerRefCheck('payment_psp_dispatches_payment_ref_ck', table.providerPaymentRef),
    providerRefCheck('payment_psp_dispatches_refund_ref_ck', table.providerRefundRef),
    opaqueCheck('payment_psp_dispatches_worker_ck', table.workerKey),
    compositionRevisionCheck('payment_psp_dispatches_composition_ck', table.originCompositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_psp_provider_dispatches', table.tenantId, table.legalEntityId),
  ],
);

/**
 * Captured provider notifications (#1157). The capture Action appends the row with its provenance;
 * only the processing columns change afterwards, and only through a scoped routine.
 */
export const pspProviderNotifications = paymentSchema.table.withRLS(
  'psp_provider_notifications',
  {
    ...scopeColumns(),
    ...provenanceColumns(),
    authenticity: text('authenticity').$type<ProviderNotificationAuthenticity>().notNull(),
    bindingId: uuid('binding_id').notNull(),
    claimedStatus: text('claimed_status'),
    correlatedOperationId: uuid('correlated_operation_id'),
    deliveryIdentity: text('delivery_identity').notNull(),
    environment: text('environment').$type<GatewayEnvironment>().notNull(),
    headers: jsonb('headers').$type<Schema.Json>().notNull(),
    notificationId: uuid('notification_id').defaultRandom().primaryKey(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processedDeliveryId: uuid('processed_delivery_id'),
    providerAccountRef: text('provider_account_ref').notNull(),
    providerEventAt: timestamp('provider_event_at', { withTimezone: true }),
    providerFamily: text('provider_family').$type<PaymentGatewayProviderFamily>().notNull(),
    providerOccurrenceId: text('provider_occurrence_id'),
    providerRefs: jsonb('provider_refs').$type<Schema.Json>().notNull(),
    query: jsonb('query').$type<Schema.Json>().notNull(),
    rawBody: bytea('raw_body').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    state: text('state').$type<ProviderNotificationState>().notNull(),
    transportDeliveryRef: text('transport_delivery_ref').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('payment_psp_notifications_scope_id_uk').on(table.tenantId, table.legalEntityId, table.notificationId),
    unique('payment_psp_notifications_binding_id_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingId,
      table.notificationId,
    ),
    unique('payment_psp_notifications_delivery_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingId,
      table.deliveryIdentity,
    ),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.bindingId,
        table.providerFamily,
        table.environment,
        table.providerAccountRef,
      ],
      foreignColumns: [
        pspProviderAccountBindings.tenantId,
        pspProviderAccountBindings.legalEntityId,
        pspProviderAccountBindings.bindingId,
        pspProviderAccountBindings.providerFamily,
        pspProviderAccountBindings.environment,
        pspProviderAccountBindings.providerAccountRef,
      ],
      name: 'payment_psp_notifications_binding_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.correlatedOperationId],
      foreignColumns: [paymentOperations.tenantId, paymentOperations.legalEntityId, paymentOperations.operationId],
      name: 'payment_psp_notifications_operation_fk',
    }).onDelete('restrict'),
    check(
      'payment_psp_notifications_vocabulary_ck',
      sql`${table.state} in (${literalList(PROVIDER_NOTIFICATION_STATES)}) and ${table.authenticity} in (${literalList(PROVIDER_NOTIFICATION_AUTHENTICITY)})`,
    ),
    gatewayFamilyCheck('payment_psp_notifications_family_ck', table.providerFamily),
    gatewayEnvironmentCheck('payment_psp_notifications_environment_ck', table.environment),
    check(
      'payment_psp_notifications_processing_ck',
      sql`(${table.processedAt} is null) = (${table.state} in ('CAPTURED', 'IGNORED'))
        and (${table.processedAt} is null) = (${table.processedDeliveryId} is null)
        and (${table.correlatedOperationId} is null or ${table.state} in ('SUBMITTED', 'SUBMISSION_HELD', 'SUBMISSION_DENIED'))`,
    ),
    check(
      'payment_psp_notifications_document_ck',
      sql`jsonb_typeof(${table.headers}) = 'object' and jsonb_typeof(${table.query}) = 'object' and jsonb_typeof(${table.providerRefs}) = 'array'
        and octet_length(${table.rawBody}) <= ${MAXIMUM_OPAQUE_BYTES}`,
    ),
    check('payment_psp_notifications_times_ck', sql`${table.verifiedAt} >= ${table.receivedAt}`),
    accountRefCheck('payment_psp_notifications_ref_ck', table.providerAccountRef),
    opaqueCheck('payment_psp_notifications_delivery_ck', table.deliveryIdentity),
    opaqueCheck('payment_psp_notifications_transport_ck', table.transportDeliveryRef),
    providerRefCheck('payment_psp_notifications_occurrence_ck', table.providerOccurrenceId),
    providerRefCheck('payment_psp_notifications_claimed_status_ck', table.claimedStatus),
    compositionRevisionCheck('payment_psp_notifications_composition_ck', table.compositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_psp_provider_notifications', table.tenantId, table.legalEntityId),
  ],
);

/**
 * Provider evidence awaiting or after governed submission through A8 (#1157/#1158). Append-only except
 * one PENDING_SUBMISSION -> terminal submission step.
 */
export const pspProviderEvidence = paymentSchema.table.withRLS(
  'psp_provider_evidence',
  {
    ...scopeColumns(),
    ...workerOriginColumns(),
    bindingId: uuid('binding_id').notNull(),
    discrepancy: jsonb('discrepancy').$type<Schema.Json>(),
    economicEffectKey: text('economic_effect_key'),
    environment: text('environment').$type<GatewayEnvironment>().notNull(),
    evidenceId: uuid('evidence_id').defaultRandom().primaryKey(),
    evidenceOrigin: text('evidence_origin').$type<ProviderEvidenceOrigin>().notNull(),
    factFamily: text('fact_family').$type<PaymentSourceFactFamily>().notNull(),
    factKind: text('fact_kind').$type<ProviderEvidenceFactKind>().notNull(),
    notificationId: uuid('notification_id'),
    observationId: uuid('observation_id'),
    observedAmountMinor: bigint('observed_amount_minor', { mode: 'number' }),
    observedCurrency: text('observed_currency'),
    operationId: uuid('operation_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    providerAccountRef: text('provider_account_ref').notNull(),
    providerFamily: text('provider_family').$type<PaymentGatewayProviderFamily>().notNull(),
    providerOccurredAt: timestamp('provider_occurred_at', { withTimezone: true }),
    providerRefs: jsonb('provider_refs').$type<Schema.Json>().notNull(),
    reason: text('reason'),
    /** Durable transport receipt: the notification's received_at, else the provider response receipt. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    sourceOccurrenceId: text('source_occurrence_id').notNull(),
    sourceRevision: bigint('source_revision', { mode: 'number' }).notNull(),
    /**
     * The system principal Shell chose for the first governed submission attempt; write-once while pending,
     * so every retry pins the same executor (`expectedPrincipalId`).
     */
    submissionExecutorPrincipalId: uuid('submission_executor_principal_id'),
    submissionState: text('submission_state').$type<ProviderEvidenceSubmissionState>().notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedDeliveryId: uuid('submitted_delivery_id'),
    /** When the provider response, lookup or signed notification proving the fact was verified. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('payment_psp_evidence_scope_id_uk').on(table.tenantId, table.legalEntityId, table.evidenceId),
    unique('payment_psp_evidence_occurrence_uk').on(
      table.tenantId,
      table.legalEntityId,
      table.bindingId,
      table.sourceOccurrenceId,
      table.sourceRevision,
    ),
    index('payment_psp_evidence_pending_idx').on(
      table.tenantId,
      table.legalEntityId,
      table.operationId,
      table.submissionState,
    ),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.paymentId, table.operationId],
      foreignColumns: [
        paymentOperations.tenantId,
        paymentOperations.legalEntityId,
        paymentOperations.paymentId,
        paymentOperations.operationId,
      ],
      name: 'payment_psp_evidence_operation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [
        table.tenantId,
        table.legalEntityId,
        table.bindingId,
        table.providerFamily,
        table.environment,
        table.providerAccountRef,
      ],
      foreignColumns: [
        pspProviderAccountBindings.tenantId,
        pspProviderAccountBindings.legalEntityId,
        pspProviderAccountBindings.bindingId,
        pspProviderAccountBindings.providerFamily,
        pspProviderAccountBindings.environment,
        pspProviderAccountBindings.providerAccountRef,
      ],
      name: 'payment_psp_evidence_binding_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.bindingId, table.notificationId],
      foreignColumns: [
        pspProviderNotifications.tenantId,
        pspProviderNotifications.legalEntityId,
        pspProviderNotifications.bindingId,
        pspProviderNotifications.notificationId,
      ],
      name: 'payment_psp_evidence_notification_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.observationId],
      foreignColumns: [observations.tenantId, observations.legalEntityId, observations.observationId],
      name: 'payment_psp_evidence_observation_fk',
    }).onDelete('restrict'),
    check(
      'payment_psp_evidence_vocabulary_ck',
      sql`${table.evidenceOrigin} in (${literalList(PROVIDER_EVIDENCE_ORIGINS)})
        and ${table.submissionState} in (${literalList(PROVIDER_EVIDENCE_SUBMISSION_STATES)})
        and ${table.factKind} in (${literalList(PROVIDER_EVIDENCE_FACT_KINDS)})
        and ${table.factFamily} in ('GATEWAY_OUTCOME', 'REFUND_EXECUTION')`,
    ),
    gatewayFamilyCheck('payment_psp_evidence_family_ck', table.providerFamily),
    gatewayEnvironmentCheck('payment_psp_evidence_environment_ck', table.environment),
    check(
      'payment_psp_evidence_money_ck',
      sql`(${table.observedAmountMinor} is null) = (${table.observedCurrency} is null) and (${table.observedAmountMinor} is null or (${table.observedAmountMinor} between 0 and ${maximumAmountMinor} and ${table.observedCurrency} ~ '^[A-Z]{3}$'))`,
    ),
    check('payment_psp_evidence_times_ck', sql`${table.verifiedAt} >= ${table.receivedAt}`),
    check(
      'payment_psp_evidence_submission_ck',
      sql`(${table.submissionState} = 'PENDING_SUBMISSION') = (${table.submittedAt} is null)
        and (${table.submittedAt} is null) = (${table.submittedDeliveryId} is null)
        and (${table.observationId} is null or ${table.submissionState} in ('ACCEPTED', 'DUPLICATE', 'HELD', 'CONFLICT'))`,
    ),
    check(
      'payment_psp_evidence_document_ck',
      sql`jsonb_typeof(${table.providerRefs}) = 'array' and (${table.discrepancy} is null or jsonb_typeof(${table.discrepancy}) = 'object')`,
    ),
    check('payment_psp_evidence_revision_ck', sql`${table.sourceRevision} between 0 and ${maximumAmountMinor}`),
    accountRefCheck('payment_psp_evidence_ref_ck', table.providerAccountRef),
    opaqueCheck('payment_psp_evidence_occurrence_ck', table.sourceOccurrenceId),
    providerRefCheck('payment_psp_evidence_effect_ck', table.economicEffectKey),
    providerRefCheck('payment_psp_evidence_reason_ck', table.reason),
    opaqueCheck('payment_psp_evidence_worker_ck', table.workerKey),
    compositionRevisionCheck('payment_psp_evidence_composition_ck', table.originCompositionRevision),
    ...tenantLegalEntityRlsPolicies('payment_psp_provider_evidence', table.tenantId, table.legalEntityId),
  ],
);

/** A bounded optional payer contact text: trimmed and non-empty when present. */
const contactTextCheck = (name: string, column: AnyPgColumn, maximumLength: number) =>
  check(
    name,
    sql`${column} is null or (${column} = btrim(${column}) and length(${column}) between 1 and ${sql.raw(String(maximumLength))})`,
  );

/**
 * Caller-supplied payer contact of one COLLECT (plan D-P3). Transient: inserted by the collection Action,
 * deleted by the scoped routine that prepares or withholds the dispatch, and purged after a bounded age.
 * The runtime role may only insert it; it is read and deleted only through SECURITY DEFINER routines.
 */
export const pspOperationPayerContacts = paymentSchema.table.withRLS(
  'psp_operation_payer_contacts',
  {
    ...scopeColumns(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    email: text('email'),
    fullName: text('full_name'),
    operationId: uuid('operation_id').notNull(),
    phone: text('phone'),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.legalEntityId, table.operationId],
      name: 'payment_psp_payer_contacts_pk',
    }),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.operationId],
      foreignColumns: [paymentOperations.tenantId, paymentOperations.legalEntityId, paymentOperations.operationId],
      name: 'payment_psp_payer_contacts_operation_fk',
    }).onDelete('restrict'),
    check(
      'payment_psp_payer_contacts_present_ck',
      sql`num_nonnulls(${table.email}, ${table.fullName}, ${table.phone}) > 0`,
    ),
    contactTextCheck('payment_psp_payer_contacts_email_ck', table.email, 254),
    contactTextCheck('payment_psp_payer_contacts_full_name_ck', table.fullName, 200),
    contactTextCheck('payment_psp_payer_contacts_phone_ck', table.phone, 40),
    ...tenantLegalEntityRlsPolicies('payment_psp_operation_payer_contacts', table.tenantId, table.legalEntityId),
  ],
);

/**
 * The notification and reconciliation route of one Provider Account Binding (plan D-P4): an opaque
 * 43-character base64url key, unique per Tenant, resolved inside the caller's Tenant only. Insert-once;
 * family and environment are the binding's own (composite foreign key).
 */
export const pspBindingRoutes = paymentSchema.table.withRLS(
  'psp_binding_routes',
  {
    ...scopeColumns(),
    bindingId: uuid('binding_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    environment: text('environment').$type<GatewayEnvironment>().notNull(),
    providerFamily: text('provider_family').$type<PaymentGatewayProviderFamily>().notNull(),
    routeKey: text('route_key').notNull(),
    routeRevision: integer('route_revision').default(1).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.routeKey], name: 'payment_psp_binding_routes_pk' }),
    unique('payment_psp_binding_routes_binding_uk').on(table.tenantId, table.legalEntityId, table.bindingId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.bindingId, table.providerFamily, table.environment],
      foreignColumns: [
        pspProviderAccountBindings.tenantId,
        pspProviderAccountBindings.legalEntityId,
        pspProviderAccountBindings.bindingId,
        pspProviderAccountBindings.providerFamily,
        pspProviderAccountBindings.environment,
      ],
      name: 'payment_psp_binding_routes_binding_fk',
    }).onDelete('restrict'),
    check('payment_psp_binding_routes_key_ck', sql`${table.routeKey} ~ '^[A-Za-z0-9_-]{43}$'`),
    check('payment_psp_binding_routes_revision_ck', sql`${table.routeRevision} > 0`),
    gatewayFamilyCheck('payment_psp_binding_routes_family_ck', table.providerFamily),
    gatewayEnvironmentCheck('payment_psp_binding_routes_environment_ck', table.environment),
    ...tenantRlsPolicies('payment_psp_binding_routes', table.tenantId),
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
  economicEffectAttributions,
  paymentAuthorizations,
  recoveryRequests,
  reconciliationCases,
  reconciliationDecisions,
  pspProviderAccountBindings,
  pspProviderAccountBindingRevisions,
  pspCredentialRevisions,
  pspGatewayEnablements,
  pspGatewayEnablementRevisions,
  pspProviderDispatches,
  pspProviderNotifications,
  pspProviderEvidence,
  pspOperationPayerContacts,
  pspBindingRoutes,
] as const;

export const PAYMENT_TABLE_INVENTORY = [
  'economic_effect_attributions',
  'gateway_assertion_redemptions',
  'method_enablement_revisions',
  'method_enablements',
  'observations',
  'operation_outcome_transitions',
  'payment_authorizations',
  'payment_operations',
  'payments',
  'psp_binding_routes',
  'psp_credential_revisions',
  'psp_gateway_enablement_revisions',
  'psp_gateway_enablements',
  'psp_operation_payer_contacts',
  'psp_provider_account_binding_revisions',
  'psp_provider_account_bindings',
  'psp_provider_dispatches',
  'psp_provider_evidence',
  'psp_provider_notifications',
  'reconciliation_cases',
  'reconciliation_decisions',
  'recovery_requests',
  'refund_item_claims',
  'source_authorities',
  'source_authority_revisions',
] as const;

/** Relational Queries v2 entry point for this owner. */
export const paymentRelations = defineRelations({
  economicEffectAttributions,
  gatewayAssertionRedemptions,
  methodEnablementRevisions,
  methodEnablements,
  observations,
  operationOutcomeTransitions,
  paymentAuthorizations,
  paymentOperations,
  payments,
  pspBindingRoutes,
  pspCredentialRevisions,
  pspGatewayEnablementRevisions,
  pspGatewayEnablements,
  pspOperationPayerContacts,
  pspProviderAccountBindingRevisions,
  pspProviderAccountBindings,
  pspProviderDispatches,
  pspProviderEvidence,
  pspProviderNotifications,
  reconciliationCases,
  reconciliationDecisions,
  recoveryRequests,
  refundItemClaims,
  sourceAuthorities,
  sourceAuthorityRevisions,
});
