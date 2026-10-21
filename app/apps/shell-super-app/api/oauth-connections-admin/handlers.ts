/**
 * "Připojené aplikace" management handlers (lane mcp-connections-ui). Port-based: grants and the company directory
 * are reached only through `ConnectionsAdminDeps`; these handlers never touch grant tables.
 */
import type {
  AgentConnectionsOverview,
  AgentOperatorsRequest,
  ConnectionAdminListRequest,
  ConnectionListResponse,
  ConnectionRevokeRequest,
  ConnectionUpdateRequest,
} from '@app/shared-contracts/agent-access';
import { CONNECTION_STATUSES } from '@app/shared-contracts/agent-access';
import { Effect } from 'effect';

import {
  ConnectionsForbidden,
  ConnectionsInvalid,
  ConnectionsNotFound,
  type ConnectionsAdminDeps,
  type ConnectionsCaller,
  type RevokeReasonCode,
} from './ports.ts';
import { adminFilterOptions, adminStats, matchesAdminFilter, uniqueIds, wideningProblem } from './rules.ts';

export const listMine = <R>(caller: ConnectionsCaller, deps: ConnectionsAdminDeps<R>) =>
  Effect.gen(function* listMine() {
    const connections = yield* deps.grants.list({
      statuses: ['active'],
      tenantId: caller.tenantId,
      userPrincipalId: caller.principalId,
    });
    return { connections, mcpUrl: deps.mcpUrl } satisfies ConnectionListResponse;
  });

export const listForAdmin = <R>(
  caller: ConnectionsCaller,
  deps: ConnectionsAdminDeps<R>,
  request: ConnectionAdminListRequest,
) =>
  Effect.gen(function* listForAdmin() {
    if (!caller.isCompanyAdmin) {
      return yield* new ConnectionsForbidden({ reason: 'Připojené aplikace celé firmy vidí jen správce firmy.' });
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
      stats: adminStats(all),
    };
  });

export const updateConnection = <R>(
  caller: ConnectionsCaller,
  deps: ConnectionsAdminDeps<R>,
  request: ConnectionUpdateRequest,
) =>
  Effect.gen(function* updateConnection() {
    const connection = yield* deps.grants.get(request.grantId);
    if (connection === undefined || connection.tenantId !== caller.tenantId) {
      return yield* new ConnectionsNotFound({ reason: 'Připojení neexistuje.' });
    }
    if (connection.user.principalId !== caller.principalId) {
      return yield* new ConnectionsForbidden({ reason: 'Přístup může upravit jen ten, kdo aplikaci připojil.' });
    }
    if (connection.status !== 'active') {
      return yield* new ConnectionsInvalid({ reason: 'Odpojené připojení už nelze upravit.' });
    }
    const problem = wideningProblem(request, connection.limits);
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

export const revokeConnection = <R>(
  caller: ConnectionsCaller,
  deps: ConnectionsAdminDeps<R>,
  request: ConnectionRevokeRequest,
) =>
  Effect.gen(function* revokeConnection() {
    const connection = yield* deps.grants.get(request.grantId);
    if (connection === undefined || connection.tenantId !== caller.tenantId) {
      return yield* new ConnectionsNotFound({ reason: 'Připojení neexistuje.' });
    }
    if (connection.status !== 'active') {
      return yield* new ConnectionsInvalid({ reason: 'Připojení už je odpojené.' });
    }
    const reasonText = request.reason?.trim() ?? '';
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
    yield* deps.grants.revoke({
      actorPrincipalId: caller.principalId,
      grantId: request.grantId,
      reasonCode,
      reasonText: reasonText === '' ? null : reasonText,
    });
    return { grantId: request.grantId, status: 'revoked' as const };
  });

export const replaceAgentOperators = <R>(
  caller: ConnectionsCaller,
  deps: ConnectionsAdminDeps<R>,
  request: AgentOperatorsRequest,
) =>
  Effect.gen(function* replaceAgentOperators() {
    if (!caller.isCompanyAdmin) {
      return yield* new ConnectionsForbidden({ reason: 'Kdo smí agenta připojit, nastavuje jen správce firmy.' });
    }
    const agents = yield* deps.directory.agents(caller.tenantId, caller.legalEntityId);
    const agentPrincipalId = request.agentPrincipalId;
    if (!agents.some((agent) => agent.principalId === agentPrincipalId)) {
      return yield* new ConnectionsNotFound({ reason: 'Agent v této firmě neexistuje.' });
    }
    const people = yield* deps.directory.people(caller.tenantId, caller.legalEntityId);
    const wanted = uniqueIds(request.operatorPrincipalIds);
    const personIds = people.map((person) => person.principalId);
    if (wanted.some((id) => !personIds.includes(id))) {
      return yield* new ConnectionsInvalid({
        reason: `Agenta mohou připojit jen aktivní lidé z firmy ${caller.legalName.replace(/\.$/u, '')}.`,
      });
    }
    const before = yield* deps.directory.operatorsOf(agentPrincipalId);
    yield* deps.directory.replaceOperators({
      actorPrincipalId: caller.principalId,
      agentPrincipalId,
      legalEntityId: caller.legalEntityId,
      operatorPrincipalIds: wanted,
      tenantId: caller.tenantId,
    });
    const removed = before.filter((id) => !wanted.includes(id));
    const agentGrants = yield* deps.grants.list({
      actingPrincipalId: agentPrincipalId,
      legalEntityId: caller.legalEntityId,
      statuses: ['active'],
      tenantId: caller.tenantId,
    });
    const affected = agentGrants.filter(
      (connection) => connection.delegatedBy !== null && removed.includes(connection.delegatedBy.principalId),
    );
    yield* Effect.forEach(
      affected,
      (connection) =>
        deps.grants.revoke({
          actorPrincipalId: caller.principalId,
          grantId: connection.grantId,
          reasonCode: 'operator_removed',
          reasonText: null,
        }),
      { discard: true },
    );
    return {
      agentPrincipalId,
      operators: people.filter((person) => wanted.includes(person.principalId)),
      revokedConnections: affected.length,
    };
  });

export const agentConnectionsOverview = <R>(caller: ConnectionsCaller, deps: ConnectionsAdminDeps<R>) =>
  Effect.gen(function* agentConnectionsOverview() {
    if (!caller.isCompanyAdmin) {
      return yield* new ConnectionsForbidden({ reason: 'Agenty a jejich připojení vidí jen správce firmy.' });
    }
    const agents = yield* deps.directory.agents(caller.tenantId, caller.legalEntityId);
    const people = yield* deps.directory.people(caller.tenantId, caller.legalEntityId);
    const active = yield* deps.grants.list({
      legalEntityId: caller.legalEntityId,
      statuses: ['active'],
      tenantId: caller.tenantId,
    });
    const entries = yield* Effect.forEach(agents, (agent) =>
      Effect.gen(function* agentEntry() {
        const operatorIds = yield* deps.directory.operatorsOf(agent.principalId);
        return {
          connections: active.filter((connection) => connection.acting.principalId === agent.principalId),
          displayName: agent.displayName,
          modules: agent.modules,
          operators: people.filter((person) => operatorIds.includes(person.principalId)),
          principalId: agent.principalId,
          seeded: agent.seeded,
          status: agent.status,
          writePolicy: agent.writePolicy,
        };
      }),
    );
    return {
      agents: entries,
      company: { legalEntityId: caller.legalEntityId, legalName: caller.legalName },
      members: people,
    } satisfies AgentConnectionsOverview;
  });
