import { tenantRlsPolicies } from '@app/core-runtime';
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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  SymmyExecutionOutcome,
  SymmyFixtureExecutionPlan,
  SymmyPinnedEffect,
  SymmyPinnedJobPlan,
  SymmyOwnerReceipt,
} from '../../shared/domain/symmy-job-execution.ts';
import { Schema } from 'effect';
import { SymmyJobLifecyclePolicyRefSchema } from '../../shared/domain/symmy-job-notification.ts';
import { symmyJobPrivacyExecutions } from './symmy-job-privacy-schema.ts';

import { defineSymmyJobLifecycleTables } from './symmy-job-lifecycle-schema.ts';

export { symmyJobPrivacyExecutions } from './symmy-job-privacy-schema.ts';
const SyncRetentionReceiptSchema = Schema.Struct({
  authorityReceiptRef: Schema.String,
  authorityRevision: Schema.String,
  policyId: SymmyJobLifecyclePolicyRefSchema.fields.policyId,
  purgedAt: Schema.DateTimeUtcFromString,
  revision: Schema.String,
});
export const SYMMY_INTEGRATION_SCHEMA_NAME = 'symmy_integration';
export const SYMMY_INTEGRATION_TABLES = [
  'executor_workload_grants',
  'gateway_assertion_redemptions',
  'import_jobs',
  'job_effects',
  'job_notifications',
  'job_retention_tombstones',
  'job_routes',
  'privacy_measure_executions',
  'route_enrollment_records',
  'route_price_read_sources',
  'route_retention_policies',
  'sync_admission_attempts',
  'sync_admissions',
] as const;

export const symmyIntegrationSchema = pgSchema(SYMMY_INTEGRATION_SCHEMA_NAME);

/**
 * The change tokens of every route row (`advance_route_change_token`). It never cycles and only the migration's role
 * may use it, so no token is handed out twice: not to two states of one route, nor to a route deleted and enrolled
 * again. Its largest value is the largest the integer column holds.
 */
export const symmyRouteChangeTokens = symmyIntegrationSchema.sequence('job_route_change_tokens', {
  maxValue: '2147483647',
});

// Assertion redemption happens before a Tenant scope can be trusted.
export const gatewayAssertionRedemptions = symmyIntegrationSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('symmy_gateway_assertion_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('symmy_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
    check('symmy_gateway_assertion_redemptions_audience_ck', sql`${table.audience} = 'symmy-integration'`),
  ],
);

const durableRoutes = [
  'adminCustomers',
  'adminProducts',
  'adminRegions',
  'customerGroupsBatch',
  'inventoryStockBatch',
  'priceLists',
  'customerGroupCustomersBatch',
  'customersBatch',
  'priceListPricesBatch',
  'priceListsBatchUpsert',
  'productsBatch',
  'assortmentRulesFixtureBatch',
  'sellerVatDeclarationsFixtureBatch',
] as const;
export type SymmyDurableRouteKey = (typeof durableRoutes)[number];

/**
 * The enrolled routes. A tenant administrator enrolls, replaces and deactivates them through
 * `integration.symmy.manage-symmy-routes` under the runtime role, which writes only its own Tenant's rows (RLS); the
 * change-token and execution-gate triggers run for every writer.
 */
export const symmyJobRoutes = symmyIntegrationSchema.table.withRLS(
  'job_routes',
  {
    active: boolean('active').notNull(),
    /**
     * Replaced with every change of the row by a token of `symmyRouteChangeTokens`, which never hands one out twice
     * (`advance_route_change_token`): an operator replaces or deactivates the route at the token it read.
     */
    changeToken: integer('change_token').default(0).notNull(),
    fixtureIds: text('fixture_ids').array().notNull(),
    fixturePlan: jsonb('fixture_plan').$type<SymmyFixtureExecutionPlan>(),
    legalEntityId: uuid('legal_entity_id'),
    lifecyclePolicy: jsonb('lifecycle_policy').$type<{
      readonly notificationRequested?: boolean;
      readonly policyId: string;
      readonly revision: string;
    }>(),
    mappingVersion: text('mapping_version').notNull(),
    principalId: uuid('principal_id').notNull(),
    routeCode: text('route_code'),
    routeId: uuid('route_id').defaultRandom().primaryKey(),
    routeKey: text('route_key', { enum: durableRoutes }).notNull(),
    routeRevision: text('route_revision').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('symmy_job_routes_tenant_route_uq').on(table.tenantId, table.routeId),
    uniqueIndex('symmy_job_routes_active_tenant_uq')
      .on(table.tenantId, table.principalId, table.routeKey)
      .where(sql`${table.active} and ${table.legalEntityId} is null and ${table.routeCode} is null`),
    uniqueIndex('symmy_job_routes_active_company_uq')
      .on(table.tenantId, table.principalId, table.legalEntityId, table.routeKey)
      .where(sql`${table.active} and ${table.legalEntityId} is not null and ${table.routeCode} is null`),
    uniqueIndex('symmy_job_routes_active_tenant_code_uq')
      .on(table.tenantId, table.principalId, table.routeKey, table.routeCode)
      .where(sql`${table.active} and ${table.legalEntityId} is null and ${table.routeCode} is not null`),
    uniqueIndex('symmy_job_routes_active_company_code_uq')
      .on(table.tenantId, table.principalId, table.legalEntityId, table.routeKey, table.routeCode)
      .where(sql`${table.active} and ${table.legalEntityId} is not null and ${table.routeCode} is not null`),
    check(
      'symmy_job_routes_selector_ck',
      sql`(
        ${table.routeKey} = 'customerGroupCustomersBatch'
        and ${table.routeCode} is not null and char_length(${table.routeCode}) between 1 and 300
      ) or (
        ${table.routeKey} in ('customersBatch', 'priceListsBatchUpsert', 'productsBatch', 'customerGroupsBatch', 'inventoryStockBatch', 'adminCustomers', 'adminProducts', 'adminRegions', 'priceLists', 'assortmentRulesFixtureBatch', 'sellerVatDeclarationsFixtureBatch') and ${table.routeCode} is null
      ) or (
        ${table.routeKey} = 'priceListPricesBatch'
        and (${table.routeCode} is null or (not ${table.active} and char_length(${table.routeCode}) between 1 and 300))
      )`,
    ),
    check(
      'symmy_job_routes_fixture_ids_ck',
      sql`cardinality(${table.fixtureIds}) between 1 and 32 and array_position(${table.fixtureIds}, null) is null`,
    ),
    // Historical inactive enrollments remain readable; active routes cannot enroll per-SKU Positions.
    check(
      'symmy_job_routes_inventory_source_ck',
      sql`(not ${table.active} or ${table.fixturePlan} is null or (
        not (${table.fixturePlan} ? 'stockScope')
        and (${table.routeKey} <> 'inventoryStockBatch' or ${table.fixturePlan} ? 'inventorySource')
        and (not (${table.fixturePlan} ? 'inventorySource') or (
          ${table.routeKey} in ('productsBatch', 'inventoryStockBatch')
          and jsonb_typeof(${table.fixturePlan} -> 'inventorySource') = 'object'
          and ${table.fixturePlan} #>> '{inventorySource,policyRef,tenantId}' = ${table.tenantId}::text
          and ${table.fixturePlan} #>> '{inventorySource,issuer,backendId}' = ${table.fixturePlan} ->> 'inventoryBackendId'
        ))
      )) is true`,
    ),
    // Only the routes that write prices enroll the grant refs of a price assertion, and then with both of its parts.
    check(
      'symmy_job_routes_price_source_ck',
      sql`${table.fixturePlan} is null or not (${table.fixturePlan} ? 'priceSource') or (
        ${table.routeKey} in ('priceListsBatchUpsert', 'priceListPricesBatch', 'productsBatch')
        and jsonb_typeof(${table.fixturePlan} -> 'priceSource' -> 'mapping') = 'object'
        and jsonb_typeof(${table.fixturePlan} -> 'priceSource' -> 'sourceAuthority') = 'object'
      )`,
    ),
    check(
      'symmy_job_routes_versions_ck',
      sql`char_length(${table.routeRevision}) between 1 and 80 and char_length(${table.mappingVersion}) between 1 and 80`,
    ),
    ...tenantRlsPolicies('symmy_job_routes_tenant', table.tenantId),
  ],
);

/**
 * Who enrolled, replaced or deactivated a route, and why: one append-only record per change, written by the operator
 * command in the transaction of the change, with the revision and change token the route had before and after it.
 * `stated_operator_ref` and `reason` are what the operator states, unauthenticated; `database_session_user` is the
 * database login that wrote the change, which the record trigger stamps. The runtime role holds no privilege on it.
 */
export const symmyRouteEnrollmentRecords = symmyIntegrationSchema.table.withRLS(
  'route_enrollment_records',
  {
    change: text('change', { enum: ['enroll', 'replace', 'deactivate'] }).notNull(),
    changeToken: integer('change_token').notNull(),
    databaseSessionUser: text('database_session_user')
      .default(sql`session_user`)
      .notNull(),
    legalEntityId: uuid('legal_entity_id'),
    previousChangeToken: integer('previous_change_token'),
    previousRevision: text('previous_revision'),
    reason: text('reason').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    recordId: uuid('record_id').defaultRandom().primaryKey(),
    routeId: uuid('route_id').notNull(),
    routeKey: text('route_key', { enum: durableRoutes }).notNull(),
    routeRevision: text('route_revision').notNull(),
    statedOperatorRef: text('stated_operator_ref').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    index('symmy_route_enrollment_records_route_idx').on(table.tenantId, table.routeId, table.recordedAt),
    check(
      'symmy_route_enrollment_records_change_ck',
      sql`${table.change} in ('enroll', 'replace', 'deactivate')
        and (${table.change} = 'enroll') = (${table.previousRevision} is null)
        and (${table.change} = 'enroll') = (${table.previousChangeToken} is null)
        and (${table.previousChangeToken} is null or ${table.changeToken} <> ${table.previousChangeToken})
        and ${table.changeToken} >= 1
        and (${table.change} <> 'deactivate' or ${table.previousRevision} = ${table.routeRevision})`,
    ),
    check(
      'symmy_route_enrollment_records_text_ck',
      sql`char_length(${table.statedOperatorRef}) between 1 and 200 and char_length(${table.reason}) between 1 and 500
        and char_length(${table.routeRevision}) between 1 and 80
        and (${table.previousRevision} is null or char_length(${table.previousRevision}) between 1 and 80)`,
    ),
    ...tenantRlsPolicies('symmy_route_enrollment_records_tenant', table.tenantId),
  ],
);

/**
 * The retention of the work a write route admits, one row per lifecycle policy revision a route pins
 * (`job_routes.lifecycle_policy`). The admission requires exactly one row matching the route's pinned policy; the
 * retention Action erases the intents of the route's work once `retention_ms` has elapsed. Rows are never changed: a new
 * retention is a new revision, pinned by a replacement of the route.
 */
export const symmyRouteRetentionPolicies = symmyIntegrationSchema.table.withRLS(
  'route_retention_policies',
  {
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    governanceLegalEntityId: uuid('governance_legal_entity_id').notNull(),
    policyId: text('policy_id').notNull(),
    retentionMs: bigint('retention_ms', { mode: 'number' }).notNull(),
    revision: text('revision').notNull(),
    /** The standing AKROS demo membership family policy (`SYMMY_DEMO_MEMBERSHIP_RETENTION`); null for every route policy. */
    routeFamily: text('route_family', { enum: ['DEMO_GROUP_MEMBERSHIP'] }),
    routeId: uuid('route_id').notNull(),
    targetLegalEntityId: uuid('target_legal_entity_id'),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('symmy_route_retention_policies_uq').on(table.tenantId, table.routeId, table.policyId, table.revision),
    foreignKey({
      columns: [table.tenantId, table.routeId],
      foreignColumns: [symmyJobRoutes.tenantId, symmyJobRoutes.routeId],
      name: 'symmy_route_retention_policies_route_fk',
    }).onDelete('restrict'),
    check(
      'symmy_route_retention_policies_values_ck',
      sql`${table.retentionMs} between 1 and 315576000000
        and char_length(${table.policyId}) between 1 and 120 and char_length(${table.revision}) between 1 and 120
        and (${table.routeFamily} is null or ${table.routeFamily} = 'DEMO_GROUP_MEMBERSHIP')
        and (${table.targetLegalEntityId} is null or ${table.targetLegalEntityId} = ${table.governanceLegalEntityId})`,
    ),
    ...tenantRlsPolicies('symmy_route_retention_policies_tenant', table.tenantId),
  ],
);

/**
 * The price source system a `priceLists` read route pages a list's prices from, and through which the Shell reads the
 * current price of a REVISE. Without a row both answer 422 projection_not_configured.
 */
export const symmyRoutePriceReadSources = symmyIntegrationSchema.table.withRLS(
  'route_price_read_sources',
  {
    ownerModuleId: text('owner_module_id').notNull(),
    routeId: uuid('route_id').notNull(),
    sourceSystemRef: text('source_system_ref').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('symmy_route_price_read_sources_route_uq').on(table.tenantId, table.routeId),
    foreignKey({
      columns: [table.tenantId, table.routeId],
      foreignColumns: [symmyJobRoutes.tenantId, symmyJobRoutes.routeId],
      name: 'symmy_route_price_read_sources_route_fk',
    }).onDelete('restrict'),
    check(
      'symmy_route_price_read_sources_values_ck',
      sql`char_length(${table.ownerModuleId}) between 1 and 120 and char_length(${table.sourceSystemRef}) between 1 and 200`,
    ),
    ...tenantRlsPolicies('symmy_route_price_read_sources_tenant', table.tenantId),
  ],
);

/**
 * What `integration.symmy.manage-symmy-routes` wrote for the Tenant's Symmy executor (the one system Principal enrolled
 * for `integration.symmy.execute-symmy-job`) because an enabled route calls under an owner workload: a workload binding
 * no system Principal held, or the registration of the executor's binding for the company a route's calls run in. Only
 * these rows are withdrawn, once no active route of the Tenant calls under the workload (in that company); an
 * installer's binding or registration is never touched. Who granted or withdrew each, and why, is kept with it.
 */
export const symmyExecutorWorkloadGrants = symmyIntegrationSchema.table.withRLS(
  'executor_workload_grants',
  {
    executorPrincipalId: uuid('executor_principal_id').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
    grantedByRef: text('granted_by_ref').notNull(),
    grantedReason: text('granted_reason').notNull(),
    /** The Core row written: the workload binding, or the company registration of `workloadBindingId`. */
    grantedRowId: uuid('granted_row_id').notNull(),
    kind: text('kind', { enum: ['binding', 'company_registration'] }).notNull(),
    legalEntityId: uuid('legal_entity_id'),
    tenantId: uuid('tenant_id').notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnByRef: text('withdrawn_by_ref'),
    workloadBindingId: uuid('workload_binding_id').notNull(),
    workloadKey: text('workload_key').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.grantedRowId], name: 'symmy_executor_workload_grants_pk' }),
    check(
      'symmy_executor_workload_grants_values_ck',
      sql`char_length(${table.workloadKey}) between 1 and 200 and char_length(${table.grantedByRef}) between 1 and 200
        and char_length(${table.grantedReason}) between 1 and 500
        and ${table.kind} in ('binding', 'company_registration')
        and (${table.kind} = 'company_registration') = (${table.legalEntityId} is not null)
        and (${table.kind} = 'binding') = (${table.grantedRowId} = ${table.workloadBindingId})
        and (${table.withdrawnAt} is null) = (${table.withdrawnByRef} is null)`,
    ),
    ...tenantRlsPolicies('symmy_executor_workload_grants_tenant', table.tenantId),
  ],
);

/** An immutable admitted internal fixture. Execution requires a separate registered workload. */
export const symmyImportJobs = symmyIntegrationSchema.table.withRLS(
  'import_jobs',
  {
    admissionInvocationId: uuid('admission_invocation_id'),
    admittedAt: timestamp('admitted_at', { withTimezone: true }).defaultNow().notNull(),
    executionPlan: jsonb('execution_plan').$type<SymmyPinnedJobPlan>(),
    fixtureId: text('fixture_id').notNull(),
    idempotencyDigest: text('idempotency_digest').notNull(),
    intentDigest: text('intent_digest').notNull(),
    jobId: uuid('job_id').defaultRandom().primaryKey(),
    legalEntityId: uuid('legal_entity_id'),
    lifecyclePolicy: jsonb('lifecycle_policy').$type<{
      readonly notificationRequested?: boolean;
      readonly policyId: string;
      readonly revision: string;
    }>(),
    mappingVersion: text('mapping_version').notNull(),
    phase: text('phase', { enum: ['admitted'] }).notNull(),
    principalId: uuid('principal_id').notNull(),
    routeCode: text('route_code'),
    routeId: uuid('route_id').notNull(),
    routeKey: text('route_key', { enum: durableRoutes }).notNull(),
    routeRevision: text('route_revision').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('symmy_import_jobs_tenant_job_uq').on(table.tenantId, table.jobId),
    unique('symmy_import_jobs_admission_uq').on(table.tenantId, table.routeId, table.routeKey, table.idempotencyDigest),
    foreignKey({
      columns: [table.tenantId, table.routeId],
      foreignColumns: [symmyJobRoutes.tenantId, symmyJobRoutes.routeId],
      name: 'symmy_import_jobs_route_fk',
    }).onDelete('restrict'),
    check(
      'symmy_import_jobs_digests_ck',
      sql`${table.idempotencyDigest} ~ '^[0-9a-f]{64}$' and ${table.intentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check('symmy_import_jobs_fixture_id_ck', sql`char_length(${table.fixtureId}) between 1 and 80`),
    check('symmy_import_jobs_phase_ck', sql`${table.phase} = 'admitted'`),
    ...tenantRlsPolicies('symmy_import_jobs_tenant', table.tenantId),
  ],
);

/** A synchronous operation receipt is not an import job and never enqueues a worker. */
export const symmySyncAdmissions = symmyIntegrationSchema.table.withRLS(
  'sync_admissions',
  {
    admissionId: uuid('admission_id').primaryKey(),
    admittedAt: timestamp('admitted_at', { withTimezone: true }).defaultNow().notNull(),
    executionPlan: jsonb('execution_plan').$type<SymmyPinnedJobPlan>().notNull(),
    idempotencyDigest: text('idempotency_digest').notNull(),
    intentDigest: text('intent_digest').notNull(),
    legalEntityId: uuid('legal_entity_id'),
    lifecyclePolicy: jsonb('lifecycle_policy').$type<{
      readonly notificationRequested?: boolean;
      readonly policyId: string;
      readonly revision: string;
    }>(),
    mappingVersion: text('mapping_version').notNull(),
    principalId: uuid('principal_id').notNull(),
    retentionReceipt: jsonb('retention_receipt').$type<typeof SyncRetentionReceiptSchema.Encoded>(),
    routeId: uuid('route_id').notNull(),
    routeKey: text('route_key', { enum: ['customerGroupsBatch', 'inventoryStockBatch'] }).notNull(),
    routeRevision: text('route_revision').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('symmy_sync_admissions_request_uq').on(table.tenantId, table.routeId, table.idempotencyDigest),
    check(
      'symmy_sync_admissions_route_key_ck',
      sql`${table.routeKey} in ('customerGroupsBatch', 'inventoryStockBatch')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.routeId],
      foreignColumns: [symmyJobRoutes.tenantId, symmyJobRoutes.routeId],
      name: 'symmy_sync_admissions_route_fk',
    }).onDelete('restrict'),
    check(
      'symmy_sync_admissions_digest_ck',
      sql`${table.idempotencyDigest} ~ '^[0-9a-f]{64}$' and ${table.intentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    unique('symmy_sync_admissions_tenant_admission_uq').on(table.tenantId, table.admissionId),
    ...tenantRlsPolicies('symmy_sync_admissions_tenant', table.tenantId),
  ],
);

/** Only exact scoped execution routines may transition an effect after admission. */
export const symmyJobEffects = symmyIntegrationSchema.table.withRLS(
  'job_effects',
  {
    claimToken: uuid('claim_token'),
    effect: jsonb('effect').$type<SymmyPinnedEffect>().notNull(),
    effectId: uuid('effect_id').primaryKey(),
    effectKey: text('effect_key').notNull(),
    itemId: uuid('item_id').notNull(),
    jobId: uuid('job_id').notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    outcome: jsonb('outcome').$type<SymmyExecutionOutcome>(),
    ownerAuthContextRef: text('owner_auth_context_ref'),
    ownerExecutorPrincipalId: uuid('owner_executor_principal_id'),
    ownerInvocationId: uuid('owner_invocation_id'),
    ownerReceipt: jsonb('owner_receipt').$type<SymmyOwnerReceipt>(),
    ownerRequestHash: text('owner_request_hash'),
    resolvedEffect: jsonb('resolved_effect').$type<SymmyPinnedEffect>(),
    state: text('state', { enum: ['planned', 'attempting', 'indeterminate', 'blocked', 'settled'] }).notNull(),
    tenantId: uuid('tenant_id').notNull(),
    version: integer('version').default(0).notNull(),
  },
  (table) => [
    unique('symmy_job_effects_tenant_effect_uq').on(table.tenantId, table.effectId),
    unique('symmy_job_effects_item_key_uq').on(table.tenantId, table.jobId, table.itemId, table.effectKey),
    foreignKey({
      columns: [table.tenantId, table.jobId],
      foreignColumns: [symmyImportJobs.tenantId, symmyImportJobs.jobId],
      name: 'symmy_job_effects_job_fk',
    }).onDelete('restrict'),
    check('symmy_job_effects_version_ck', sql`${table.version} >= 0`),
    check(
      'symmy_job_effects_state_ck',
      sql`${table.state} in ('planned', 'attempting', 'indeterminate', 'blocked', 'settled')`,
    ),
    check(
      'symmy_job_effects_ref_ck',
      sql`${table.effect}->>'itemId' = ${table.itemId}::text and ${table.effect}->>'effectKey' = ${table.effectKey} and ${table.effect} #>> '{ref,effectId}' = ${table.effectId}::text`,
    ),
    check(
      'symmy_job_effects_lease_ck',
      sql`(${table.state} = 'attempting') = (${table.claimToken} is not null and ${table.leaseUntil} is not null)`,
    ),
    check(
      'symmy_job_effects_outcome_ck',
      sql`((${table.state} in ('settled', 'blocked')) = (${table.outcome} is not null))
        or (${table.state} = 'indeterminate' and ${table.outcome}->>'status' is not distinct from 'unavailable')`,
    ),
    check('symmy_job_effects_blocked_ck', sql`${table.state} <> 'blocked' or ${table.outcome}->>'status' = 'denied'`),
    ...tenantRlsPolicies('symmy_job_effects_tenant', table.tenantId),
  ],
);

/** Minimal owner receipt link for a new Core attempt returning an already accepted business admission. */
export const symmySyncAdmissionAttempts = symmyIntegrationSchema.table.withRLS(
  'sync_admission_attempts',
  {
    admissionId: uuid('admission_id').notNull(),
    invocationId: uuid('invocation_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.admissionId],
      foreignColumns: [symmySyncAdmissions.tenantId, symmySyncAdmissions.admissionId],
      name: 'symmy_sync_attempt_scope_fk',
    }).onDelete('restrict'),
    ...tenantRlsPolicies('symmy_sync_admission_attempts_tenant', table.tenantId),
  ],
);

export const { symmyJobNotifications, symmyJobRetentionTombstones } = defineSymmyJobLifecycleTables(symmyImportJobs);

export const symmyIntegrationRelations = defineRelations({
  gatewayAssertionRedemptions,
  symmyExecutorWorkloadGrants,
  symmyImportJobs,
  symmyJobEffects,
  symmyJobNotifications,
  symmyJobPrivacyExecutions,
  symmyJobRetentionTombstones,
  symmyJobRoutes,
  symmyRouteEnrollmentRecords,
  symmyRoutePriceReadSources,
  symmyRouteRetentionPolicies,
  symmySyncAdmissionAttempts,
  symmySyncAdmissions,
});
