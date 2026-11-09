import { tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
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
  'gateway_assertion_redemptions',
  'import_jobs',
  'job_effects',
  'job_notifications',
  'job_retention_tombstones',
  'job_routes',
  'privacy_measure_executions',
  'sync_admission_attempts',
  'sync_admissions',
] as const;

export const symmyIntegrationSchema = pgSchema(SYMMY_INTEGRATION_SCHEMA_NAME);
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
] as const;
export type SymmyDurableRouteKey = (typeof durableRoutes)[number];

/** Trusted, administrator-managed enrollment. Runtime can only read these records. */
export const symmyJobRoutes = symmyIntegrationSchema.table.withRLS(
  'job_routes',
  {
    active: boolean('active').notNull(),
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
    unique('symmy_job_routes_scope_selector_uq')
      .on(table.tenantId, table.principalId, table.legalEntityId, table.routeKey, table.routeCode)
      .nullsNotDistinct(),
    check(
      'symmy_job_routes_selector_ck',
      sql`(
        ${table.routeKey} in ('customerGroupCustomersBatch', 'priceListPricesBatch')
        and ${table.routeCode} is not null and char_length(${table.routeCode}) between 1 and 300
      ) or (
        ${table.routeKey} in ('customersBatch', 'priceListsBatchUpsert', 'productsBatch', 'customerGroupsBatch', 'inventoryStockBatch', 'adminCustomers', 'adminProducts', 'adminRegions', 'priceLists') and ${table.routeCode} is null
      )`,
    ),
    check(
      'symmy_job_routes_fixture_ids_ck',
      sql`cardinality(${table.fixtureIds}) between 1 and 32 and array_position(${table.fixtureIds}, null) is null`,
    ),
    check(
      'symmy_job_routes_versions_ck',
      sql`char_length(${table.routeRevision}) between 1 and 80 and char_length(${table.mappingVersion}) between 1 and 80`,
    ),
    ...tenantRlsPolicies('symmy_job_routes_tenant', table.tenantId),
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
    routeRevision: text('route_revision').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('symmy_sync_admissions_request_uq').on(table.tenantId, table.routeId, table.idempotencyDigest),
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
      sql`(${table.state} in ('settled', 'blocked')) = (${table.outcome} is not null)`,
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
  symmyImportJobs,
  symmyJobEffects,
  symmyJobNotifications,
  symmyJobPrivacyExecutions,
  symmyJobRetentionTombstones,
  symmyJobRoutes,
  symmySyncAdmissionAttempts,
  symmySyncAdmissions,
});
