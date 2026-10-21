/**
 * Live `GrantAdminPort` (lane mcp-connections-ui): an adapter over the grant store and connection service of lane
 * connection-grants (api/oauth-connections/**). It never reads or writes grant, binding or Better Auth tables itself;
 * it joins the service's summary with the grant row (user, revocation) and the acting principal's live authority.
 */
import type { ConnectionLimits, ConnectionStatus, ConnectionSummary } from '@app/shared-contracts/agent-access';
import type {
  ConnectionGrantStatus,
  ConnectionSummary as ServiceConnectionSummary,
} from '@app/shared-contracts/oauth-connections';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Effect } from 'effect';

import { AuthDatabase } from '../auth/db/client.ts';

import {
  getConnectionSummary,
  listConnectionSummaries,
  loadActingAuthority,
  revokeConnection,
  updateConnection,
} from '../oauth-connections/connection-service.ts';
import { findGrant, listGrants } from '../oauth-connections/grant-store.ts';
import type { GrantRow } from '../oauth-connections/types.ts';
import { ConnectionsUnavailable } from './ports.ts';
import type { GrantAdminPort, GrantListFilter } from './ports.ts';

const unavailable = (cause: unknown) => new ConnectionsUnavailable({ cause });

/** Read-only view of `core.audit_events`, used for the free-text reason of `oauth.connection.revoked`. */
const auditEvents = pgSchema('core').table('audit_events', {
  eventType: text('event_type').notNull(),
  evidenceJson: jsonb('evidence_json').$type<Readonly<Record<string, unknown>>>().notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

/** Administrator notes of revoked grants (newest audit row per grant wins). */
const revokeNotesOf = Effect.fn('GrantAdminPortLive.revokeNotesOf')(function* (rows: readonly GrantRow[]) {
  const revoked = rows.filter((row) => row.status === 'revoked');
  const notes = new Map<string, string>();
  const tenantId = revoked[0]?.tenantId;
  if (tenantId === undefined) {
    return notes;
  }
  const { executor } = yield* AuthDatabase;
  const grantIdOf = sql<string>`${auditEvents.evidenceJson} ->> 'grantId'`;
  const found = yield* executor
    .select({ evidence: auditEvents.evidenceJson, grantId: grantIdOf })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.eventType, 'oauth.connection.revoked'),
        inArray(
          grantIdOf,
          revoked.map((row) => row.grantId),
        ),
      ),
    )
    .orderBy(desc(auditEvents.occurredAt));
  for (const item of found) {
    const note = item.evidence['note'];
    if (!notes.has(item.grantId) && typeof note === 'string' && note.trim() !== '') {
      notes.set(item.grantId, note.trim());
    }
  }
  return notes;
});

const isListed = (status: ConnectionGrantStatus): status is ConnectionStatus => status !== 'draft';

const actingKey = (row: GrantRow): string =>
  `${row.tenantId}|${row.legalEntityId}|${row.actingKind}|${row.actingPrincipalId}`;

/** Live limits of every distinct acting principal (per company) among the rows. */
const limitsOf = (rows: readonly GrantRow[]) =>
  Effect.forEach(
    [...new Map(rows.map((row) => [actingKey(row), row])).values()],
    (row) =>
      loadActingAuthority({
        actingKind: row.actingKind,
        actingPrincipalId: row.actingPrincipalId,
        legalEntityId: row.legalEntityId,
        tenantId: row.tenantId,
      }).pipe(
        Effect.map(
          (authority) =>
            [
              actingKey(row),
              { maxWritePolicy: authority.policyCap, modules: authority.offered },
            ] as const satisfies readonly [string, ConnectionLimits],
        ),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((entries) => new Map<string, ConnectionLimits>(entries)));

const toAdminSummary = (
  summary: ServiceConnectionSummary,
  row: GrantRow,
  limits: ConnectionLimits,
  revokeNote: string | null,
): ConnectionSummary | undefined => {
  const status = summary.status;
  if (!isListed(status)) {
    return undefined;
  }
  return {
    acting: summary.acting,
    allModules: row.modules === 'all',
    client: summary.client,
    createdAt: summary.createdAt,
    delegatedBy: summary.delegatedBy,
    grantId: summary.grantId,
    granted: { modules: row.modules === 'all' ? [] : [...row.modules], writePolicy: row.writePolicy },
    lastUsedAt: summary.lastUsedAt,
    legalEntityId: summary.legalEntityId,
    legalName: summary.legalName,
    limits,
    modules: summary.modules,
    profileId: summary.profileId,
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    revokeNote,
    revokeReason: row.revokeReason,
    status,
    tenantId: summary.tenantId,
    user: { displayName: summary.userDisplayName, principalId: row.userPrincipalId },
    writePolicy: summary.writePolicy,
  };
};

const joinSummaries = Effect.fn('GrantAdminPortLive.joinSummaries')(function* (
  rows: readonly GrantRow[],
  summaries: readonly ServiceConnectionSummary[],
) {
  const rowsById = new Map(rows.map((row) => [row.grantId, row]));
  const listed = rows.filter((row) => isListed(row.status));
  const limits = yield* limitsOf(listed);
  const notes = yield* revokeNotesOf(listed);
  return summaries.flatMap((summary) => {
    const row = rowsById.get(summary.grantId);
    const rowLimits = row === undefined ? undefined : limits.get(actingKey(row));
    const result =
      row === undefined || rowLimits === undefined
        ? undefined
        : toAdminSummary(summary, row, rowLimits, notes.get(row.grantId) ?? null);
    return result === undefined ? [] : [result];
  });
});

const list = (filter: GrantListFilter) =>
  Effect.gen(function* listLive() {
    const storeFilter = {
      ...(filter.actingPrincipalId === undefined ? {} : { actingPrincipalId: filter.actingPrincipalId }),
      ...(filter.legalEntityId === undefined ? {} : { legalEntityId: filter.legalEntityId }),
      ...(filter.userPrincipalId === undefined ? {} : { userPrincipalId: filter.userPrincipalId }),
      statuses: filter.statuses,
      tenantId: filter.tenantId,
    };
    const rows = yield* listGrants(storeFilter);
    const summaries = yield* listConnectionSummaries(storeFilter);
    const joined: readonly ConnectionSummary[] = yield* joinSummaries(rows, summaries);
    return joined;
  }).pipe(Effect.mapError(unavailable));

const get = (grantId: string) =>
  Effect.gen(function* getLive() {
    const row = yield* findGrant(grantId);
    if (row === undefined || !isListed(row.status)) {
      return undefined;
    }
    const summary = yield* getConnectionSummary(grantId);
    if (summary === undefined) {
      return undefined;
    }
    const [joined] = yield* joinSummaries([row], [summary]);
    const result: ConnectionSummary | undefined = joined;
    return result;
  }).pipe(Effect.mapError(unavailable));

const update: GrantAdminPortLiveShape['update'] = (input) =>
  updateConnection({
    actorPrincipalId: input.actorPrincipalId,
    grantId: input.grantId,
    modules: input.modules === 'all' ? 'all' : [...input.modules],
    writePolicy: input.writePolicy,
  }).pipe(Effect.asVoid, Effect.mapError(unavailable));

const revoke: GrantAdminPortLiveShape['revoke'] = (input) =>
  revokeConnection({
    actorPrincipalId: input.actorPrincipalId,
    grantId: input.grantId,
    note: input.reasonText,
    reason: input.reasonCode,
  }).pipe(Effect.asVoid, Effect.mapError(unavailable));

type ServicesOf<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

/** Services the connection-grants functions need (database, SpiceDB, context access, module catalog, OAuth flow). */
export type GrantAdminPortServices =
  | ServicesOf<ReturnType<typeof list>>
  | ServicesOf<ReturnType<typeof get>>
  | ServicesOf<ReturnType<typeof updateConnection>>
  | ServicesOf<ReturnType<typeof revokeConnection>>;

type GrantAdminPortLiveShape = GrantAdminPort<GrantAdminPortServices>;

export const grantAdminPortLive: GrantAdminPort<GrantAdminPortServices> = { get, list, revoke, update };
