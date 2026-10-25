/** Joins retained grants, live connection authority and Core-owned revocation notes for management. */
import {
  ContextAccess,
  OAuthAuthenticationAudit,
  OAuthConnectionCompanies,
  OAuthGrantOwners,
  OAuthGrantRegistry,
  oauthConnectionRevocationNotesRead,
  ReadRuntime,
} from '@app/core-runtime';
import type { OperationalScopeRequest } from '@app/core-runtime';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { ConnectionStatusSchema } from '@app/shared-contracts/agent-access';
import type { ConnectionLimits, ConnectionSummary } from '@app/shared-contracts/agent-access';
import type { ConnectionSummary as ServiceConnectionSummary } from '@app/shared-contracts/oauth-connections';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import { OAuthCredentials } from '../auth/db/oauth-credentials.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import {
  connectionSummariesOf,
  loadActingAuthority,
  revokeConnection,
  updateConnection,
} from '../oauth-connections/connection-service.ts';
import { OAuthFlow } from '../oauth-connections/oauth-flow.ts';
import type { GrantRow } from '../oauth-connections/types.ts';
import { ConnectionsUnavailable } from './connections-unavailable.ts';
import { GrantAdmin } from './ports.ts';
import type { ConnectionsCaller, GrantAdminPort, GrantListFilter } from './ports.ts';

const unavailable = (cause: unknown) => new ConnectionsUnavailable({ cause });

export interface GrantAdminRequest {
  readonly principal: ConnectionsCaller['principal'];
  readonly transport: OperationalScopeRequest;
}

const isListed = Schema.is(ConnectionStatusSchema);

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
    // Each authority opens two SpiceDB reads; reserve a Worker connection for PostgreSQL.
    { concurrency: 2 },
  ).pipe(Effect.map((entries) => new Map<string, ConnectionLimits>(entries)));

const toAdminSummary = (
  summary: ServiceConnectionSummary,
  row: GrantRow,
  limits: ConnectionLimits,
  revokeNote: string | null,
): ConnectionSummary | undefined => {
  const { status } = summary;
  if (!isListed(status)) {
    return undefined;
  }
  return {
    acting: summary.acting,
    allModules: row.modules === 'all',
    client: summary.client,
    createdAt: summary.createdAt,
    delegatedBy: summary.delegatedBy,
    granted: { modules: row.modules === 'all' ? [] : [...row.modules], writePolicy: row.writePolicy },
    grantId: summary.grantId,
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

/** Capture native connection and governed Read dependencies once for this original request. */
export const GrantAdminLive = (request: GrantAdminRequest) =>
  Layer.effect(
    GrantAdmin,
    Effect.gen(function* grantAdminService() {
      const registry = yield* OAuthGrantRegistry;
      const reads = yield* ReadRuntime;
      const services = Context.make(OAuthGrantRegistry, registry).pipe(
        Context.add(ActionAuthority, yield* ActionAuthority),
        Context.add(ContextAccess, yield* ContextAccess),
        Context.add(OAuthAuthenticationAudit, yield* OAuthAuthenticationAudit),
        Context.add(OAuthConnectionCompanies, yield* OAuthConnectionCompanies),
        Context.add(OAuthCredentials, yield* OAuthCredentials),
        Context.add(OAuthFlow, yield* OAuthFlow),
        Context.add(OAuthGrantOwners, yield* OAuthGrantOwners),
        Context.add(ShellInstalledModuleCatalog, yield* ShellInstalledModuleCatalog),
      );

      /** Core verifies exact company, retained owners and current admin rights using the original ingress carrier. */
      const revokeNotesOf = Effect.fn('GrantAdmin.revokeNotesOf')(function* revokeNotesOf(rows: readonly GrantRow[]) {
        const revoked = rows.filter((row) => row.status === 'revoked');
        if (revoked.length === 0) {
          return new Map<string, string>();
        }
        if (
          revoked.some(
            (row) =>
              row.tenantId !== request.principal.tenantId || row.legalEntityId !== request.principal.legalEntityId,
          )
        ) {
          return yield* unavailable('Revocation notes require the original exact-company context');
        }
        const result = yield* reads
          .runRead({
            input: { grantIds: revoked.map((row) => row.grantId) },
            principal: request.principal,
            registration: oauthConnectionRevocationNotesRead,
            transport: request.transport,
          })
          .pipe(Effect.mapError(unavailable));
        return new Map(result.notes.map((note) => [note.grantId, note.note]));
      });

      const joinSummaries = Effect.fn('GrantAdmin.joinSummaries')(function* joinSummaries(
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

      const list = Effect.fn('GrantAdmin.list')(
        function* list(filter: GrantListFilter) {
          const rows = yield* registry.listGrants(filter);
          const summaries = yield* connectionSummariesOf(filter.tenantId, rows);
          const joined: readonly ConnectionSummary[] = yield* joinSummaries(rows, summaries);
          return joined;
        },
        Effect.mapError(unavailable),
        Effect.provideContext(services),
      );

      const get = Effect.fn('GrantAdmin.get')(
        function* get(grantId: string) {
          const retained = yield* registry.findGrant(grantId);
          if (Option.isNone(retained) || !isListed(retained.value.status)) {
            return Option.none<ConnectionSummary>();
          }
          const row = retained.value;
          const summaries = yield* connectionSummariesOf(row.tenantId, [row]);
          const [joined] = yield* joinSummaries([row], summaries);
          return Option.fromUndefinedOr(joined);
        },
        Effect.mapError(unavailable),
        Effect.provideContext(services),
      );

      const update: GrantAdminPort<never>['update'] = (input) =>
        updateConnection({
          actorPrincipalId: input.actorPrincipalId,
          grantId: input.grantId,
          modules: input.modules === 'all' ? 'all' : [...input.modules],
          writePolicy: input.writePolicy,
        }).pipe(Effect.asVoid, Effect.mapError(unavailable), Effect.provideContext(services));

      const revoke: GrantAdminPort<never>['revoke'] = (input) =>
        revokeConnection({
          actorPrincipalId: input.actorPrincipalId,
          grantId: input.grantId,
          note: input.reasonText,
          reason: input.reasonCode,
        }).pipe(Effect.asVoid, Effect.mapError(unavailable), Effect.provideContext(services));

      return { get, list, revoke, update } satisfies GrantAdminPort<never>;
    }),
  );
