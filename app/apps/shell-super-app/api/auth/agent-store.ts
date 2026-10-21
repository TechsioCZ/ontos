// Agent profiles and MCP token store, database side (lane agent-entities). Reads Core audit evidence of the
// manage-demo-account Action and Better Auth API keys; the pure folding and scope rules are in agent-store-model.ts.
import { DEFAULT_MCP_PUBLIC_URL } from '@app/shared-contracts/agent-access';
import type { McpToken } from '@app/shared-contracts/agent-access';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Config, DateTime, Effect } from 'effect';

import { foldAgentProfiles, mcpScopeOfMetadata, mcpTokenMetadata } from './agent-store-model.ts';
import { DemoAccountUnavailable } from './demo-accounts.ts';
import { AuthDatabase } from './db/client.ts';
import { apikey } from './db/schema.ts';

/** Read views of the Core tables this lane reads, plus the audit insert shape (same as demo-accounts.ts). */
const core = pgSchema('core');
const coreBindings = core.table('principal_auth_bindings', {
  principalAuthBindingId: uuid('principal_auth_binding_id').notNull(),
  principalId: uuid('principal_id').notNull(),
  provider: text('provider').notNull(),
  providerSubjectId: text('provider_subject_id').notNull(),
  status: text('status').notNull(),
  subjectType: text('subject_type').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});
const coreAuditEvents = core.table('audit_events', {
  auditEventId: uuid('audit_event_id').notNull(),
  authBindingId: uuid('auth_binding_id'),
  eventType: text('event_type').notNull(),
  evidenceJson: jsonb('evidence_json').$type<Readonly<Record<string, unknown>>>().notNull(),
  legalEntityId: uuid('legal_entity_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  outcome: text('outcome').notNull(),
  principalId: uuid('principal_id'),
  tenantId: uuid('tenant_id').notNull(),
});

/** Insert shape of `core.audit_events` (copied from demo-accounts.ts). */
const coreAuditEventsWrite = core.table('audit_events', {
  auditProfile: text('audit_profile').notNull(),
  authBindingId: uuid('auth_binding_id'),
  authMethod: text('auth_method').notNull(),
  eventType: text('event_type').notNull(),
  evidenceJson: jsonb('evidence_json').$type<Readonly<Record<string, unknown>>>().notNull(),
  legalEntityId: uuid('legal_entity_id'),
  outcome: text('outcome').notNull(),
  outcomeCode: text('outcome_code').notNull(),
  outcomeStage: text('outcome_stage').notNull(),
  principalId: uuid('principal_id'),
  targetModuleKey: text('target_module_key'),
  tenantId: uuid('tenant_id').notNull(),
});

const ACTION_KEY = 'core.identity.manage-demo-account';

const unavailable = (cause: unknown) => new DemoAccountUnavailable({ cause });
const iso = (value: Date) => DateTime.formatIso(DateTime.fromDateUnsafe(value));

export const mcpPublicUrl = Config.String('ONTOS_MCP_PUBLIC_URL').pipe(
  Effect.orElseSucceed(() => DEFAULT_MCP_PUBLIC_URL),
);

/** Current profile of each principal: seeded profile, overridden by the latest administrator evidence. */
export const loadAgentProfiles = Effect.fn('AgentStore.loadAgentProfiles')(function* loadAgentProfiles(
  tenantId: string,
  principalIds: readonly string[],
) {
  if (principalIds.length === 0) {
    return foldAgentProfiles([], []);
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ evidence: coreAuditEvents.evidenceJson })
    .from(coreAuditEvents)
    .where(
      and(
        eq(coreAuditEvents.tenantId, tenantId),
        eq(coreAuditEvents.eventType, 'action.executed'),
        eq(coreAuditEvents.outcome, 'succeeded'),
        sql`${coreAuditEvents.evidenceJson}->>'actionKey' = ${ACTION_KEY}`,
        sql`${coreAuditEvents.evidenceJson}->>'operation' in ('create-agent', 'configure-agent')`,
      ),
    )
    .orderBy(asc(coreAuditEvents.occurredAt))
    .pipe(Effect.mapError(unavailable));
  return foldAgentProfiles(
    principalIds,
    rows.map((row) => row.evidence),
  );
});

/** Scopes a freshly issued Better Auth API key to one company and lifts its 10-per-day limit. */
export const finalizeMcpToken = Effect.fn('AgentStore.finalizeMcpToken')(function* finalizeMcpToken(input: {
  readonly authBindingId: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
}) {
  const { executor } = yield* AuthDatabase;
  const [binding] = yield* executor
    .select({ providerSubjectId: coreBindings.providerSubjectId })
    .from(coreBindings)
    .where(
      and(
        eq(coreBindings.tenantId, input.tenantId),
        eq(coreBindings.principalAuthBindingId, input.authBindingId),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (binding === undefined) {
    return yield* new DemoAccountUnavailable({ cause: 'MCP token binding not found' });
  }
  yield* executor
    .update(apikey)
    .set({ metadata: mcpTokenMetadata(input.legalEntityId), rateLimitEnabled: false, requestCount: 0 })
    .where(eq(apikey.id, binding.providerSubjectId))
    .pipe(Effect.mapError(unavailable));
});

/** Company scope of an API key, or undefined when the key is unknown or unscoped. */
export const mcpTokenScope = Effect.fn('AgentStore.mcpTokenScope')(function* mcpTokenScope(providerKeyId: string) {
  const { executor } = yield* AuthDatabase;
  const [row] = yield* executor
    .select({ metadata: apikey.metadata })
    .from(apikey)
    .where(eq(apikey.id, providerKeyId))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  return mcpScopeOfMetadata(row?.metadata);
});

/** Tokens of one principal, optionally only those scoped to one company; last use from the audit trail. */
export const listMcpTokens = Effect.fn('AgentStore.listMcpTokens')(function* listMcpTokens(input: {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}) {
  const { executor } = yield* AuthDatabase;
  const bindings = yield* executor
    .select({
      authBindingId: coreBindings.principalAuthBindingId,
      createdAt: apikey.createdAt,
      enabled: apikey.enabled,
      metadata: apikey.metadata,
      name: apikey.name,
      start: apikey.start,
      status: coreBindings.status,
    })
    .from(coreBindings)
    .innerJoin(apikey, eq(apikey.id, coreBindings.providerSubjectId))
    .where(
      and(
        eq(coreBindings.tenantId, input.tenantId),
        eq(coreBindings.principalId, input.principalId),
        eq(coreBindings.provider, 'better_auth'),
        eq(coreBindings.subjectType, 'api_key'),
        inArray(coreBindings.status, ['active', 'disabled']),
      ),
    )
    .orderBy(desc(apikey.createdAt))
    .pipe(Effect.mapError(unavailable));
  const scoped =
    input.legalEntityId === undefined
      ? bindings
      : bindings.filter((row) => mcpScopeOfMetadata(row.metadata) === input.legalEntityId);
  if (scoped.length === 0) {
    return [] satisfies McpToken[];
  }
  const ids = scoped.map((row) => row.authBindingId);
  const uses = yield* executor
    .select({ authBindingId: coreAuditEvents.authBindingId, occurredAt: coreAuditEvents.occurredAt })
    .from(coreAuditEvents)
    .where(
      and(
        eq(coreAuditEvents.tenantId, input.tenantId),
        eq(coreAuditEvents.eventType, 'authn.api_key_used'),
        inArray(coreAuditEvents.authBindingId, ids),
      ),
    )
    .orderBy(desc(coreAuditEvents.occurredAt))
    .limit(500)
    .pipe(Effect.mapError(unavailable));
  const lastUse = new Map<string, Date>();
  for (const use of uses) {
    if (use.authBindingId !== null && !lastUse.has(use.authBindingId)) {
      lastUse.set(use.authBindingId, use.occurredAt);
    }
  }
  return scoped.map(
    (row): McpToken => {
      const latest = lastUse.get(row.authBindingId);
      return {
        authBindingId: row.authBindingId,
        createdAt: iso(row.createdAt),
        enabled: row.status === 'active' && row.enabled !== false,
        lastUsedAt: latest === undefined ? null : iso(latest),
        name: row.name,
        start: row.start,
      };
    },
  );
});

export interface McpAuditInput {
  readonly authBindingId: string | null;
  readonly authMethod: string;
  readonly eventType: string;
  readonly evidence: Readonly<Record<string, string | null>>;
  readonly legalEntityId: string | null;
  readonly outcomeCode: string;
  readonly outcomeStage: 'authn' | 'execution';
  readonly principalId: string;
  readonly tenantId: string;
}

/** Sensitive audit row for MCP token activity. Auditing never fails the request. */
export const recordMcpAuditEvent = (input: McpAuditInput) =>
  AuthDatabase.pipe(
    Effect.flatMap(({ executor }) =>
      executor.insert(coreAuditEventsWrite).values({
        auditProfile: 'sensitive',
        authBindingId: input.authBindingId,
        authMethod: input.authMethod,
        eventType: input.eventType,
        evidenceJson: input.evidence,
        legalEntityId: input.legalEntityId,
        outcome: 'succeeded',
        outcomeCode: input.outcomeCode,
        outcomeStage: input.outcomeStage,
        principalId: input.principalId,
        targetModuleKey: 'core.identity',
        tenantId: input.tenantId,
      }),
    ),
    Effect.ignore,
  );

export const recordApiKeyUse = (input: {
  readonly audience: string;
  readonly authBindingId: string;
  readonly legalEntityId: string | undefined;
  readonly principalId: string;
  readonly tenantId: string;
}) =>
  recordMcpAuditEvent({
    authBindingId: input.authBindingId,
    authMethod: 'api_key',
    eventType: 'authn.api_key_used',
    evidence: { audience: input.audience, authBindingId: input.authBindingId },
    legalEntityId: input.legalEntityId ?? null,
    outcomeCode: 'api_key_used',
    outcomeStage: 'authn',
    principalId: input.principalId,
    tenantId: input.tenantId,
  });
