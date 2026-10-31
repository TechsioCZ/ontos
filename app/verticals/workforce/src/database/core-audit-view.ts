/**
 * Read-only column views of the Core audit tables (owned by packages/core-runtime, schema `core`) for the
 * "AI aktivita" section of the Zaměstnanci page. Not part of this vertical's drizzle schema: no migration is ever
 * generated from this file. Column names mirror packages/core-runtime/src/db/schema.ts.
 */
import { pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const core = pgSchema('core');

export const coreAuditEvents = core.table('audit_events', {
  actionInvocationId: uuid('action_invocation_id'),
  auditEventId: uuid('audit_event_id').primaryKey(),
  legalEntityId: uuid('legal_entity_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  outcome: text('outcome').notNull(),
  outcomeCode: text('outcome_code').notNull(),
  outcomeStage: text('outcome_stage').notNull(),
  principalId: uuid('principal_id'),
  targetModuleKey: text('target_module_key'),
  tenantId: uuid('tenant_id').notNull(),
});

export const corePrincipals = core.table('principals', {
  displayName: text('display_name').notNull(),
  kind: text('kind').notNull(),
  principalId: uuid('principal_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
});

export const coreActionInvocations = core.table('action_invocations', {
  actionInvocationId: uuid('action_invocation_id').primaryKey(),
  actionKey: text('action_key').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});
