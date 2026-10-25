/** Management operations never write grant tables; the supplied services own persistence and projection. */
import type {
  AgentOperatorsRequest,
  ConnectionAdminListRequest,
  ConnectionListResponse,
  ConnectionRevokeRequest,
  ConnectionUpdateRequest,
} from '@app/shared-contracts/agent-access';
import { CONNECTION_REVOKE_REASON_MAX, CONNECTION_STATUSES } from '@app/shared-contracts/agent-access';
import { Effect, Option } from 'effect';

import { ConnectionsForbidden } from './connections-forbidden.ts';
import { ConnectionsGone } from './connections-gone.ts';
import { ConnectionsInvalid } from './connections-invalid.ts';
import { ConnectionsNotFound } from './connections-not-found.ts';
import type { ConnectionsAdminDeps, ConnectionsCaller, RevokeReasonCode } from './ports.ts';
import { adminFilterOptions, adminStats, matchesAdminFilter, uniqueIds, wideningProblem } from './rules.ts';

export const listMine = Effect.fn('ConnectionsAdmin.listMine')(function* listMineEffect<R>(
  caller: ConnectionsCaller,
  deps: ConnectionsAdminDeps<R>,
) {
  const connections = yield* deps.grants.list({
    statuses: ['active'],
    tenantId: caller.tenantId,
    userPrincipalId: caller.principalId,
  });
  return { connections, mcpUrl: deps.mcpUrl } satisfies ConnectionListResponse;
});

export const listForAdmin = Effect.fn('ConnectionsAdmin.listForAdmin')(function* listForAdminEffect<R>(
  caller: ConnectionsCaller,
  deps: ConnectionsAdminDeps<R>,
  request: ConnectionAdminListRequest,
) {
  if (!caller.isCompanyAdmin) {
    return yield* new ConnectionsForbidden({ reason: 'Připojené aplikace celé firmy vidí jen správce firmy.' });
  }
  const { status } = request.filter;
  if (status !== undefined && !CONNECTION_STATUSES.some((candidate) => candidate === status)) {
    return yield* new ConnectionsInvalid({ reason: `Neznámý stav připojení „${status.slice(0, 40)}“.` });
  }
  const all = yield* deps.grants.list({
    legalEntityId: caller.legalEntityId,
    statuses: CONNECTION_STATUSES,
    tenantId: caller.tenantId,
  });
  return {
    company: { legalEntityId: caller.legalEntityId, legalName: caller.legalName },
    connections: all.filter((connection) => matchesAdminFilter(connection, request.filter)),
    filterOptions: adminFilterOptions(all),
    mcpUrl: deps.mcpUrl,
    stats: adminStats(all),
  };
});

export const updateConnection = Effect.fn('ConnectionsAdmin.updateConnection')(function* updateConnectionEffect<R>(
  caller: ConnectionsCaller,
  deps: ConnectionsAdminDeps<R>,
  request: ConnectionUpdateRequest,
) {
  const found = yield* deps.grants.get(request.grantId);
  if (Option.isNone(found) || found.value.tenantId !== caller.tenantId) {
    return yield* new ConnectionsNotFound({ reason: 'Připojení neexistuje.' });
  }
  const { value: connection } = found;
  if (connection.user.principalId !== caller.principalId) {
    return yield* new ConnectionsForbidden({ reason: 'Přístup může upravit jen ten, kdo aplikaci připojil.' });
  }
  if (connection.status !== 'active') {
    return yield* new ConnectionsGone({ reason: 'Připojení už není aktivní, takže ho nelze upravit.' });
  }
  const problem = wideningProblem(request, connection);
  if (problem !== undefined) {
    return yield* new ConnectionsInvalid({ reason: problem });
  }
  yield* deps.grants.update({
    actorPrincipalId: caller.principalId,
    grantId: request.grantId,
    modules: request.allModules ? 'all' : request.modules,
    writePolicy: request.writePolicy,
  });
  return { grantId: request.grantId, status: 'active' as const };
});

export const revokeConnection = Effect.fn('ConnectionsAdmin.revokeConnection')(function* revokeConnectionEffect<R>(
  caller: ConnectionsCaller,
  deps: ConnectionsAdminDeps<R>,
  request: ConnectionRevokeRequest,
) {
  const found = yield* deps.grants.get(request.grantId);
  if (Option.isNone(found) || found.value.tenantId !== caller.tenantId) {
    return yield* new ConnectionsNotFound({ reason: 'Připojení neexistuje.' });
  }
  const { value: connection } = found;
  const reasonText = request.reason?.trim() ?? '';
  if (reasonText.length > CONNECTION_REVOKE_REASON_MAX) {
    return yield* new ConnectionsInvalid({ reason: `Důvod může mít nejvýš ${CONNECTION_REVOKE_REASON_MAX} znaků.` });
  }
  let reasonCode: RevokeReasonCode;
  if (connection.user.principalId === caller.principalId) {
    reasonCode = 'user';
  } else if (caller.isCompanyAdmin && connection.legalEntityId === caller.legalEntityId) {
    if (reasonText === '') {
      return yield* new ConnectionsInvalid({ reason: 'Uveďte důvod odpojení.' });
    }
    reasonCode = 'admin';
  } else {
    return yield* new ConnectionsForbidden({
      reason: 'Připojení může odpojit jen ten, kdo ho vytvořil, nebo správce firmy, ve které platí.',
    });
  }
  if (connection.status !== 'active') {
    return yield* new ConnectionsGone({ reason: 'Připojení už je odpojené.' });
  }
  yield* deps.grants.revoke({
    actorPrincipalId: caller.principalId,
    grantId: request.grantId,
    reasonCode,
    // Only an administrator's reason is kept: the owner's own Odpojit has no reason field.
    reasonText: reasonCode === 'admin' ? reasonText : null,
  });
  return { grantId: request.grantId, status: 'revoked' as const };
});

export const replaceAgentOperators = Effect.fn('ConnectionsAdmin.replaceAgentOperators')(
  function* replaceAgentOperatorsEffect<R>(
    caller: ConnectionsCaller,
    deps: ConnectionsAdminDeps<R>,
    request: AgentOperatorsRequest,
  ) {
    if (!caller.isCompanyAdmin) {
      return yield* new ConnectionsForbidden({ reason: 'Kdo smí agenta připojit, nastavuje jen správce firmy.' });
    }
    const snapshot = yield* deps.directory.snapshot;
    const { people } = snapshot;
    const { agentPrincipalId } = request;
    const agent = snapshot.agents.find((candidate) => candidate.principalId === agentPrincipalId);
    if (agent === undefined) {
      return yield* new ConnectionsNotFound({ reason: 'Agent v této firmě neexistuje.' });
    }
    if (agent.status !== 'active') {
      return yield* new ConnectionsInvalid({ reason: 'Operátory lze nastavit jen aktivnímu agentovi.' });
    }
    const wanted = uniqueIds(request.operatorPrincipalIds);
    const wantedIds = new Set(wanted);
    const personIds = new Set(people.map((person) => person.principalId));
    if (wanted.some((id) => !personIds.has(id))) {
      return yield* new ConnectionsInvalid({
        reason: `Agenta mohou připojit jen aktivní lidé z firmy ${caller.legalName.replace(/\.$/u, '')}.`,
      });
    }
    const agentGrants = yield* deps.grants.list({
      actingPrincipalId: agentPrincipalId,
      legalEntityId: caller.legalEntityId,
      statuses: ['active'],
      tenantId: caller.tenantId,
    });
    // Include unfinished revocations from an earlier committed projection, not only today's graph delta.
    const affected = agentGrants.filter(
      (connection) => connection.delegatedBy !== null && !wantedIds.has(connection.delegatedBy.principalId),
    );
    yield* deps.directory.replaceOperators({
      agentPrincipalId,
      context: 'operators-edited',
      operatorPrincipalIds: wanted,
      revokedConnections: affected.length,
      snapshot,
    });
    yield* Effect.forEach(
      affected,
      (connection) =>
        deps.grants.revoke({
          actorPrincipalId: caller.principalId,
          grantId: connection.grantId,
          reasonCode: 'operator_removed',
          reasonText: null,
        }),
      // Keep the established revocation order, and never revoke before confirmed projection.
      { concurrency: 1, discard: true },
    );
    return {
      agentPrincipalId,
      operators: people.filter((person) => wantedIds.has(person.principalId)),
      revokedConnections: affected.length,
    };
  },
);
