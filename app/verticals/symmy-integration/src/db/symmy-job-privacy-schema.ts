import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import type { OwnerExecutionOutcome } from '@app/privacy/domain/privacy-measure-handoff';
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const schema = pgSchema('symmy_integration');

/** Only safe operational references and the full handoff digest survive; no subject or private source payload is copied. */
export const symmyJobPrivacyExecutions = schema.table.withRLS(
  'privacy_measure_executions',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    attempt: integer('attempt').notNull(),
    governanceLegalEntityId: uuid('governance_legal_entity_id').notNull(),
    handoffFingerprint: text('handoff_fingerprint').notNull(),
    idempotencyDigest: text('idempotency_digest').notNull(),
    outcome: jsonb('outcome').$type<OwnerExecutionOutcome>().notNull(),
    receiptId: uuid('receipt_id').primaryKey(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    resourceId: uuid('resource_id').notNull(),
    resourceKind: text('resource_kind', { enum: ['JOB', 'SYNC'] }).notNull(),
    retentionStatus: text('retention_status', { enum: ['PURGED', 'ALREADY_PURGED', 'BLOCKED'] }).notNull(),
    targetLegalEntityId: uuid('target_legal_entity_id'),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    unique('symmy_privacy_executions_scope_key_uq').on(
      table.tenantId,
      table.governanceLegalEntityId,
      table.idempotencyDigest,
      table.attempt,
    ),
    check(
      'symmy_privacy_executions_attempt_ck',
      sql`${table.attempt} >= 1 and (${table.outcome}->>'attempt')::integer = ${table.attempt}`,
    ),
    check(
      'symmy_privacy_executions_digests_ck',
      sql`${table.handoffFingerprint} ~ '^[a-f0-9]{64}$' and ${table.idempotencyDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'symmy_privacy_executions_kind_ck',
      sql`${table.resourceKind} in ('JOB','SYNC') and ${table.retentionStatus} in ('PURGED','ALREADY_PURGED','BLOCKED')`,
    ),
    check(
      'symmy_privacy_executions_outcome_ck',
      sql`${table.outcome}->>'owningCapability' = 'integration.symmy' and ${table.outcome}->>'status' in ('SUCCEEDED','BLOCKED')`,
    ),
    ...tenantLegalEntityRlsPolicies('symmy_privacy_executions_scope', table.tenantId, table.governanceLegalEntityId),
  ],
);
