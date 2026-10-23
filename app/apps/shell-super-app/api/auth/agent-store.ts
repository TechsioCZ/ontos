// Agent profiles, database side. Reads only the native configure-agent Action audit evidence;
// the pure folding rules are in agent-store-model.ts.
import { and, asc, eq, sql } from 'drizzle-orm';
import { jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Effect } from 'effect';

import { foldAgentProfiles } from './agent-store-model.ts';
import { DemoAccountUnavailable } from './demo-accounts.ts';
import { AuthDatabase } from './db/client.ts';

/** Read view of the Core audit table this lane reads. */
const core = pgSchema('core');
const coreAuditEvents = core.table('audit_events', {
  auditEventId: uuid('audit_event_id').notNull(),
  authBindingId: uuid('auth_binding_id'),
  eventType: text('event_type').notNull(),
  evidenceJson: jsonb('evidence_json').$type<unknown>().notNull(),
  legalEntityId: uuid('legal_entity_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  outcome: text('outcome').notNull(),
  principalId: uuid('principal_id'),
  tenantId: uuid('tenant_id').notNull(),
});

const ACTION_KEY = 'core.identity.configure-agent';

const unavailable = (cause: unknown) => new DemoAccountUnavailable({ cause });

/** Current exact-company profile, backed only by successful native Action evidence. */
export const loadAgentProfiles = Effect.fn('AgentStore.loadAgentProfiles')(function* loadAgentProfiles(
  tenantId: string,
  legalEntityId: string,
  principalIds: readonly string[],
) {
  if (principalIds.length === 0) {
    return foldAgentProfiles(legalEntityId, [], []);
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ evidence: coreAuditEvents.evidenceJson })
    .from(coreAuditEvents)
    .where(
      and(
        eq(coreAuditEvents.tenantId, tenantId),
        eq(coreAuditEvents.legalEntityId, legalEntityId),
        eq(coreAuditEvents.eventType, 'action.executed'),
        eq(coreAuditEvents.outcome, 'succeeded'),
        sql`${coreAuditEvents.evidenceJson}->>'actionKey' = ${ACTION_KEY}`,
        sql`${coreAuditEvents.evidenceJson}->>'operation' in ('create-agent', 'configure-agent')`,
      ),
    )
    .orderBy(asc(coreAuditEvents.occurredAt), asc(coreAuditEvents.auditEventId))
    .pipe(Effect.mapError(unavailable));
  return foldAgentProfiles(legalEntityId, principalIds, rows);
});
