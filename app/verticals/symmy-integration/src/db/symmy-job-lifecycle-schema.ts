import { tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { symmyImportJobs } from './schema.ts';

const schema = pgSchema('symmy_integration');

/** Main schema constructs these after import_jobs, avoiding a runtime schema cycle. */
export const defineSymmyJobLifecycleTables = (jobs: typeof symmyImportJobs) => ({
  symmyJobNotifications: schema.table.withRLS(
    'job_notifications',
    {
      attempt: integer('attempt').default(0).notNull(),
      claimToken: uuid('claim_token'),
      destinationDigest: text('destination_digest').notNull(),
      initialBackoffMs: integer('initial_backoff_ms').notNull(),
      jobId: uuid('job_id').notNull(),
      leaseUntil: timestamp('lease_until', { withTimezone: true }),
      maxAttempts: integer('max_attempts').notNull(),
      maxBackoffMs: integer('max_backoff_ms').notNull(),
      nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
      payloadDigest: text('payload_digest').notNull(),
      policyId: text('policy_id').notNull(),
      policyRevision: text('policy_revision').notNull(),
      recipientId: text('recipient_id').notNull(),
      state: text('state', { enum: ['pending', 'attempting', 'delivered', 'exhausted'] }).notNull(),
      tenantId: uuid('tenant_id').notNull(),
      timeoutMs: integer('timeout_ms').notNull(),
      version: integer('version').default(0).notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.tenantId, table.jobId], name: 'symmy_job_notifications_pk' }),
      foreignKey({
        columns: [table.tenantId, table.jobId],
        foreignColumns: [jobs.tenantId, jobs.jobId],
        name: 'symmy_job_notifications_job_fk',
      }).onDelete('restrict'),
      check(
        'symmy_job_notifications_attempt_ck',
        sql`${table.attempt} between 0 and ${table.maxAttempts} and ${table.maxAttempts} between 1 and 20`,
      ),
      check(
        'symmy_job_notifications_state_ck',
        sql`${table.state} in ('pending','attempting','delivered','exhausted')`,
      ),
      check(
        'symmy_job_notifications_lease_ck',
        sql`(${table.state} = 'attempting') = (${table.claimToken} is not null and ${table.leaseUntil} is not null)`,
      ),
      check(
        'symmy_job_notifications_versions_ck',
        sql`${table.version} >= 0 and char_length(${table.policyId}) between 1 and 120 and char_length(${table.policyRevision}) between 1 and 120`,
      ),
      check(
        'symmy_job_notifications_digest_ck',
        sql`${table.destinationDigest} ~ '^[0-9a-f]{64}$' and ${table.payloadDigest} ~ '^[0-9a-f]{64}$'`,
      ),
      check(
        'symmy_job_notifications_retry_ck',
        sql`${table.initialBackoffMs} between 1 and 3600000 and ${table.maxBackoffMs} between ${table.initialBackoffMs} and 86400000 and ${table.timeoutMs} between 1 and 60000`,
      ),
      ...tenantRlsPolicies('symmy_job_notifications_tenant', table.tenantId),
    ],
  ),
  symmyJobRetentionTombstones: schema.table.withRLS(
    'job_retention_tombstones',
    {
      authorityReceiptRef: text('authority_receipt_ref').notNull(),
      authorityRevision: text('authority_revision').notNull(),
      jobId: uuid('job_id').notNull(),
      policyId: text('policy_id').notNull(),
      policyRevision: text('policy_revision').notNull(),
      purgedAt: timestamp('purged_at', { withTimezone: true }).defaultNow().notNull(),
      retainedEffectIds: jsonb('retained_effect_ids').$type<readonly string[]>().notNull(),
      tenantId: uuid('tenant_id').notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.tenantId, table.jobId], name: 'symmy_job_retention_tombstones_pk' }),
      foreignKey({
        columns: [table.tenantId, table.jobId],
        foreignColumns: [jobs.tenantId, jobs.jobId],
        name: 'symmy_job_retention_tombstones_job_fk',
      }).onDelete('restrict'),
      check('symmy_job_retention_tombstones_effects_ck', sql`jsonb_typeof(${table.retainedEffectIds}) = 'array'`),
      ...tenantRlsPolicies('symmy_job_retention_tombstones_tenant', table.tenantId),
    ],
  ),
});
