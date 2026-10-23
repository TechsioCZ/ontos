// lane mcp-connections-ui: Core principals + SpiceDB membership/operators of one company for the management handlers.
// Reads `core.principals` (display names, kinds, status) through AuthDatabase, takes company membership from SpiceDB
// via openDemoAccountGrants, reads and writes agent operator relations via openPrincipalOperators, and audits
// operator changes in `core.audit_events`.
import { openDemoAccountGrants, openPrincipalOperators } from '@app/core-runtime';
import type { PrincipalRef } from '@app/shared-contracts/agent-access';
import { and, eq, inArray } from 'drizzle-orm';
import { jsonb, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { Effect } from 'effect';

import { loadAgentProfiles } from '../auth/agent-store.ts';
import { AuthDatabase } from '../auth/db/client.ts';
import { ConnectionsUnavailable } from './ports.ts';
import type { CompanyAgent, CompanyDirectoryPort } from './ports.ts';

const core = pgSchema('core');
const corePrincipals = core.table('principals', {
  displayName: text('display_name').notNull(),
  kind: text('kind').notNull(),
  principalId: uuid('principal_id').notNull(),
  status: text('status').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

/** Insert shape of `core.audit_events` (same as demo-accounts.ts). */
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

const unavailable = (cause: unknown) => new ConnectionsUnavailable({ cause });

/** Principal ids with `member` on the company (SpiceDB). */
const members = (tenantId: string, legalEntityId: string) =>
  Effect.scoped(Effect.flatMap(openDemoAccountGrants, (grants) => grants.companyMembers(tenantId, legalEntityId))).pipe(
    Effect.mapError(unavailable),
  );

const people = Effect.fn('CompanyDirectory.people')(function* people(tenantId: string, memberIds: readonly string[]) {
  if (memberIds.length === 0) {
    return [] as readonly PrincipalRef[];
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({ displayName: corePrincipals.displayName, principalId: corePrincipals.principalId })
    .from(corePrincipals)
    .where(
      and(
        eq(corePrincipals.tenantId, tenantId),
        eq(corePrincipals.kind, 'human'),
        eq(corePrincipals.status, 'active'),
        inArray(corePrincipals.principalId, [...memberIds]),
      ),
    )
    .pipe(Effect.mapError(unavailable));
  return [...rows].sort((left, right) => left.displayName.localeCompare(right.displayName, 'cs'));
});

const agents = Effect.fn('CompanyDirectory.agents')(function* agents(
  tenantId: string,
  legalEntityId: string,
  memberIds: readonly string[],
) {
  if (memberIds.length === 0) {
    return [] as readonly CompanyAgent[];
  }
  const { executor } = yield* AuthDatabase;
  const rows = yield* executor
    .select({
      displayName: corePrincipals.displayName,
      principalId: corePrincipals.principalId,
      status: corePrincipals.status,
    })
    .from(corePrincipals)
    .where(
      and(
        eq(corePrincipals.tenantId, tenantId),
        eq(corePrincipals.kind, 'agent'),
        inArray(corePrincipals.principalId, [...memberIds]),
      ),
    )
    .pipe(Effect.mapError(unavailable));
  const profiles = yield* loadAgentProfiles(
    tenantId,
    legalEntityId,
    rows.map((row) => row.principalId),
  ).pipe(Effect.mapError(unavailable));
  return [...rows]
    .map((row): CompanyAgent => {
      const profile = profiles.get(row.principalId);
      return {
        description: profile?.description ?? null,
        displayName: row.displayName,
        modules: profile?.modules ?? [],
        ownerPrincipalId: profile?.ownerPrincipalId ?? null,
        principalId: row.principalId,
        hasProfile: profile?.hasProfile ?? false,
        status: row.status === 'active' ? 'active' : row.status === 'archived' ? 'archived' : 'disabled',
        writePolicy: profile?.writePolicy ?? 'read_only',
      };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'cs'));
});

const operatorsOf = (agentPrincipalId: string) =>
  Effect.scoped(Effect.flatMap(openPrincipalOperators, (operators) => operators.operatorsOf(agentPrincipalId))).pipe(
    Effect.mapError(unavailable),
  );

const replaceOperators = Effect.fn('CompanyDirectory.replaceOperators')(function* replaceOperators(input: {
  readonly actorPrincipalId: string;
  readonly agentPrincipalId: string;
  readonly context: 'agent-created' | 'agent-deleted' | 'operators-edited';
  readonly legalEntityId: string;
  readonly operatorPrincipalIds: readonly string[];
  readonly revokedConnections: number;
  readonly tenantId: string;
}) {
  const before = yield* operatorsOf(input.agentPrincipalId);
  const unchanged =
    before.length === input.operatorPrincipalIds.length &&
    before.every((id) => input.operatorPrincipalIds.includes(id));
  if (unchanged) {
    return;
  }
  yield* Effect.scoped(
    Effect.flatMap(openPrincipalOperators, (operators) =>
      operators.replaceOperators({
        agentPrincipalId: input.agentPrincipalId,
        operatorPrincipalIds: input.operatorPrincipalIds,
        tenantId: input.tenantId,
      }),
    ),
  ).pipe(Effect.mapError(unavailable));
  if (input.context === 'agent-deleted') {
    return;
  }
  const { executor } = yield* AuthDatabase;
  yield* executor
    .insert(coreAuditEventsWrite)
    .values({
      auditProfile: 'sensitive',
      authBindingId: null,
      authMethod: 'session',
      eventType: 'identity.agent_operators_changed',
      evidenceJson: {
        agentPrincipalId: input.agentPrincipalId,
        context: input.context,
        operatorPrincipalIds: input.operatorPrincipalIds.join(','),
        previousOperatorPrincipalIds: before.join(','),
        revokedConnections: String(input.revokedConnections),
      },
      legalEntityId: input.legalEntityId,
      outcome: 'succeeded',
      outcomeCode: 'agent_operators_changed',
      outcomeStage: 'execution',
      principalId: input.actorPrincipalId,
      targetModuleKey: 'core.identity',
      tenantId: input.tenantId,
    })
    .pipe(Effect.mapError(unavailable));
});

export const companyDirectoryLive: CompanyDirectoryPort<AuthDatabase> = {
  agents,
  members,
  operatorsOf,
  people,
  replaceOperators,
};
