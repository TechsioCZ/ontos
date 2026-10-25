/**
 * Agent entities of the selected company (Lidé a role › Agentní entity). The company administrator lists, creates,
 * configures, deactivates / reactivates and deletes agents. Every change runs the Core Action
 * `core.identity.configure-agent` for profiles and `core.identity.manage-agent-status` for status/archive, with sensitive
 * audit; then its company-scoped role policy is rebuilt from the selected module access and write policy,
 * and its operators are written with principal#tenant. Deactivation and deletion revoke the agent's active OAuth
 * connections at once and withdraw its waiting proposals. Changes of one company's agents run one at a time
 * (a private session advisory lock, without an open SQL transaction), so two parallel creates cannot both pass the
 * unique-name check. No tokens or API keys: agents connect only through the OAuth consent ('Za agenta'). Errors are
 * Connections* errors with Czech reasons.
 */
import {
  ActionRuntime,
  agentModuleAccessOf,
  manageAgentStatusAction,
  configureAgentAction,
  openDemoAccountGrants,
  withPostgresSessionAdvisoryLock,
} from '@app/core-runtime';
import type { DemoAccountGrants, ManageAgentStatusPayload, OperationalScopeRequest } from '@app/core-runtime';
import type {
  AgentEntity,
  AgentEntityOverview,
  ManageAgentEntityRequest,
  ManageAgentEntityResponse,
} from '@app/shared-contracts/agent-access';
import { Effect, Match, Predicate, Redacted } from 'effect';
import { ActionAuthorizationLifecycle } from '@app/core-runtime/outbox/core-system-worker';

import { composedModulesOf } from '../agent-platform/composed-modules.ts';
import { withdrawAllPendingOfAgent } from '../agent-platform/proposal-store.ts';
import { mcpModulesOf } from '../mcp/catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';

import { ConnectionsForbidden } from '../oauth-connections-admin/connections-forbidden.ts';
import { ConnectionsGone } from '../oauth-connections-admin/connections-gone.ts';
import { ConnectionsInvalid } from '../oauth-connections-admin/connections-invalid.ts';
import { ConnectionsNotFound } from '../oauth-connections-admin/connections-not-found.ts';
import { ConnectionsUnavailable } from '../oauth-connections-admin/connections-unavailable.ts';
import type { ConnectionsAdminDeps } from '../oauth-connections-admin/ports.ts';
import { agentDraftProblem, agentModuleOptions, agentRolePreset } from './agent-entities-model.ts';
import { legalEntityWriteRelationsOf } from './agent-write-relations.ts';
import {
  auditForbiddenAttempt,
  auditTrail,
  companyRoleTemplates,
  derivedUuid,
  requireAdministrator,
} from './demo-accounts.ts';
import { AgentActionRequestIdentity } from './agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from './agent-request-identity.ts';
import { AuthConfig } from './config.ts';
import type { DemoAccountCaller, DemoAccountForbidden } from './demo-accounts.ts';
import type { DemoAccountConflict } from './demo-account-conflict.ts';
import type { DemoAccountInvalid } from './demo-account-invalid.ts';
import type { DemoAccountUnavailable } from './demo-account-unavailable.ts';

const CHANGE_STATUS = 'change-status';
const unavailable = (cause: unknown) => new ConnectionsUnavailable({ cause });

const fromDemoAccountError = (
  error: DemoAccountConflict | DemoAccountForbidden | DemoAccountInvalid | DemoAccountUnavailable,
) =>
  Match.value(error).pipe(
    Match.tag(
      'DemoAccountForbidden',
      () => new ConnectionsForbidden({ reason: 'Agenty spravuje jen správce firmy. Pokus je zapsaný v auditu.' }),
    ),
    Match.tag('DemoAccountInvalid', () => new ConnectionsInvalid({ reason: 'Tuto změnu agenta nelze provést.' })),
    Match.tag('DemoAccountConflict', () => new ConnectionsGone({ reason: 'Agent se mezitím změnil. Obnovte seznam.' })),
    Match.tag('DemoAccountUnavailable', unavailable),
    Match.exhaustive,
  );

const fromActionError = (error: { readonly _tag: string }) =>
  Match.value(error).pipe(
    Match.tag(
      'IdentityLifecycleConflictError',
      'ActionRequestHashConflict',
      () => new ConnectionsGone({ reason: 'Agent se mezitím změnil. Obnovte seznam a zkuste to znovu.' }),
    ),
    Match.tag(
      'IdentityTargetInvalidError',
      'ActionPayloadValidationError',
      () => new ConnectionsInvalid({ reason: 'Tuto změnu agenta nelze provést.' }),
    ),
    Match.tag(
      'ActionPermissionDenied',
      'ActionPolicyDenied',
      () => new ConnectionsForbidden({ reason: 'K této změně nemáte oprávnění. Pokus je zapsaný v auditu.' }),
    ),
    Match.orElse((failure) => new ConnectionsUnavailable({ cause: failure })),
  );

const cleanDescription = (value: string | null) => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

const roleTemplates = (caller: DemoAccountCaller, transport: OperationalScopeRequest) =>
  companyRoleTemplates(caller, transport).pipe(Effect.mapError(fromDemoAccountError));

export const companyCatalog = Effect.fn('AgentEntities.companyCatalog')(function* readCompanyCatalog(
  legalEntityId: string,
  roles: Effect.Success<ReturnType<typeof roleTemplates>>,
  grants: Pick<DemoAccountGrants, 'rolePolicyOf'>,
) {
  // Native role policy expansion is bounded per template principal. Two roles plus one operator read leave the sixth
  // Worker connection for PostgreSQL. Unbounded fan-out can cancel a queued fetch before it makes progress.
  const templates = yield* Effect.forEach(
    roles,
    (role) =>
      grants.rolePolicyOf(role.templatePrincipalId).pipe(Effect.map((relationships) => ({ relationships, role }))),
    { concurrency: 2 },
  ).pipe(Effect.mapError(unavailable));
  const union = templates.flatMap(({ relationships }) => relationships);
  const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(unavailable));
  const { labelOf } = composedModulesOf(mcpModulesOf(installed.composition));
  return {
    actions: installed.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.actions.map((action) => ({
        actionKey: action.actionKey,
        legalEntityScope: action.legalEntityScope,
        owningModuleKey: action.owningModuleId,
      })),
    ),
    labelOf,
    legalEntityWriteRelations: legalEntityWriteRelationsOf(installed.composition),
    options: agentModuleOptions(agentModuleAccessOf(union, legalEntityId), labelOf),
    presets: templates.map(({ relationships, role }) =>
      agentRolePreset(role, agentModuleAccessOf(relationships, legalEntityId)),
    ),
    union,
  };
});

export const listAgentEntities = Effect.fn('AgentEntities.listAgentEntities')(function* readAgentEntities<R>(
  caller: DemoAccountCaller,
  deps: ConnectionsAdminDeps<R>,
) {
  const transport = yield* AgentReadRequestIdentity;
  const { legalEntityId, tenantId } = caller.principal;
  const grants = yield* openDemoAccountGrants.pipe(Effect.mapError(unavailable));
  yield* requireAdministrator(caller, grants).pipe(
    Effect.mapError((error) =>
      Predicate.isTagged(error, 'DemoAccountForbidden')
        ? new ConnectionsForbidden({ reason: 'Agenty spravuje jen správce firmy.' })
        : fromDemoAccountError(error),
    ),
  );
  const company = Effect.gen(function* companyAgents() {
    const snapshot = yield* deps.directory.snapshot;
    // Agents someone answers for first, then technical ones without an owner.
    const agents = snapshot.agents
      .filter((agent) => agent.status !== 'archived')
      .toSorted((left, right) => Number(left.ownerPrincipalId === null) - Number(right.ownerPrincipalId === null));
    const audit = yield* auditTrail(caller, transport, 'agents').pipe(Effect.mapError(fromDemoAccountError));
    return { agents, audit, people: snapshot.people };
  });
  const roles = yield* roleTemplates(caller, transport);
  const [catalog, { agents, audit, people }] = yield* Effect.all(
    [companyCatalog(legalEntityId, roles, grants), company],
    { concurrency: 2 },
  );
  // Connection summaries have their own live-authority reads; do not overlap them with role/operator fan-out.
  const active = yield* deps.grants.list({ legalEntityId, statuses: ['active'], tenantId });
  const entries = agents.map((agent): AgentEntity => ({
    connections: active.filter((connection) => connection.acting.principalId === agent.principalId),
    description: agent.description,
    displayName: agent.displayName,
    hasProfile: agent.hasProfile,
    modules: agent.modules,
    operators: people.filter((person) => agent.operatorPrincipalIds.includes(person.principalId)),
    owner: people.find((person) => person.principalId === agent.ownerPrincipalId) ?? null,
    principalId: agent.principalId,
    status: agent.status,
    writePolicy: agent.writePolicy,
  }));
  const overview: AgentEntityOverview = {
    agents: entries,
    audit,
    company: { legalEntityId, legalName: caller.legalName },
    members: people,
    modules: catalog.options,
    presets: catalog.presets,
  };
  return overview;
}, Effect.scoped);

/** Serialize company agent changes without keeping a SQL transaction open across external effects. */
const withCompanyAgentLock = Effect.fn('AgentEntities.withCompanyAgentLock')(function* lockCompanyAgents<A, E, R>(
  tenantId: string,
  legalEntityId: string,
  effect: Effect.Effect<A, E, R>,
) {
  const configuration = yield* AuthConfig;
  return yield* withPostgresSessionAdvisoryLock(
    Redacted.make(configuration.connectionString),
    `agent-entities:${tenantId}:${legalEntityId}`,
    effect,
  ).pipe(Effect.catchTag('SessionAdvisoryLockUnavailable', (error) => Effect.fail(unavailable(error))));
});

const revokeAgentConnections = Effect.fn('AgentEntities.revokeAgentConnections')(function* revokeConnections<R>(
  caller: DemoAccountCaller,
  deps: ConnectionsAdminDeps<R>,
  agentPrincipalId: string,
  reasonText: string,
) {
  const { legalEntityId, principalId: actorPrincipalId, tenantId } = caller.principal;
  const connections = yield* deps.grants.list({
    actingPrincipalId: agentPrincipalId,
    legalEntityId,
    statuses: ['active'],
    tenantId,
  });
  yield* Effect.forEach(
    connections,
    (connection) =>
      deps.grants.revoke({ actorPrincipalId, grantId: connection.grantId, reasonCode: 'admin', reasonText }),
    // Revocations retain their original order; each completion precedes the next connection's mutation.
    { concurrency: 1, discard: true },
  );
  return connections.length;
});

// This transport is Core's persisted Action request identity, not an ambient log/span identifier.
const changeAgent = Effect.fn('AgentEntities.changeAgent')(function* applyAgentChange<R>(
  caller: DemoAccountCaller,
  request: ManageAgentEntityRequest,
  deps: ConnectionsAdminDeps<R>,
  grants: DemoAccountGrants,
) {
  const transport = yield* AgentActionRequestIdentity;
  const { legalEntityId, tenantId } = caller.principal;
  const runtime = yield* ActionRuntime;
  const run = Effect.fn('AgentEntities.commitOrResumeAgentStatus')(function* commitOrResumeAgentStatus(
    payload: ManageAgentStatusPayload,
  ) {
    // Native same-key execution validates the original carrier and verifies the exact payload hash before
    // reporting ActionAlreadyCommitted. That confirmation resumes cleanup, not a fabricated Action result.
    yield* runtime
      .runAction({ payload, principal: caller.principal, registration: manageAgentStatusAction, transport })
      .pipe(
        Effect.asVoid,
        Effect.catchTag('ActionAlreadyCommitted', () => Effect.void),
        Effect.mapError(fromActionError),
      );
    const lifecycle = yield* ActionAuthorizationLifecycle;
    const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(unavailable));
    yield* lifecycle
      .reconcilePrincipal(tenantId, payload.principalId, installed.composition.revision)
      .pipe(Effect.mapError(unavailable));
  });
  const revokeActive = (agentPrincipalId: string, reasonText: string) =>
    revokeAgentConnections(caller, deps, agentPrincipalId, reasonText);
  const withdrawProposals = (agentPrincipalId: string, note: string) =>
    withdrawAllPendingOfAgent(caller.principal, { agentPrincipalId, note }).pipe(Effect.mapError(unavailable));

  if (request.operation === 'create') {
    const snapshot = yield* deps.directory.snapshot;
    const agents = snapshot.agents.filter((agent) => agent.status !== 'archived');
    const memberIds = snapshot.people.map((person) => person.principalId);
    // Same idempotency key = same principal id: a retry replays the Core Action instead of failing the name check.
    const principalId = derivedUuid(`${tenantId}:${legalEntityId}:${transport.idempotencyKey}:agent`);
    const catalog = yield* companyCatalog(legalEntityId, yield* roleTemplates(caller, transport), grants);
    const problem = agentDraftProblem({
      displayName: request.displayName,
      existingNames: agents.flatMap((agent) => (agent.principalId === principalId ? [] : [agent.displayName])),
      labelOf: catalog.labelOf,
      memberIds,
      modules: request.modules,
      operatorPrincipalIds: request.operatorPrincipalIds,
      options: catalog.options,
      ownerPrincipalId: request.ownerPrincipalId,
    });
    if (problem !== null) {
      return yield* new ConnectionsInvalid({ reason: problem });
    }
    // A retry of a committed create (ActionAlreadyCommitted) finishes the same agent's grants and operators again.
    const result = yield* runtime
      .runAction({
        payload: {
          description: cleanDescription(request.description),
          displayName: request.displayName.trim(),
          modules: request.modules,
          operation: 'create-agent',
          ownerPrincipalId: request.ownerPrincipalId,
          principalId,
          writePolicy: request.writePolicy,
        },
        principal: caller.principal,
        registration: configureAgentAction,
        transport,
      })
      .pipe(
        Effect.catchTag('ActionAlreadyCommitted', () => Effect.succeed({ principalId })),
        Effect.mapError(fromActionError),
      );
    const lifecycle = yield* ActionAuthorizationLifecycle;
    const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(unavailable));
    yield* lifecycle
      .reconcilePrincipal(tenantId, result.principalId, installed.composition.revision)
      .pipe(Effect.mapError(unavailable));
    // Creation changes membership; read its governed post-create snapshot before setting operators.
    yield* deps.directory.replaceOperators({
      agentPrincipalId: result.principalId,
      context: 'agent-created',
      operatorPrincipalIds: [...new Set(request.operatorPrincipalIds)],
      revokedConnections: 0,
      snapshot: yield* deps.directory.snapshot,
    });
    const created: ManageAgentEntityResponse = {
      grantsGranted: 0,
      grantsRevoked: 0,
      operation: 'create',
      principalId: result.principalId,
      revokedConnections: 0,
      status: 'active',
    };
    return created;
  }

  if (request.operation === 'configure') {
    const snapshot = yield* deps.directory.snapshot;
    const agents = snapshot.agents.filter((agent) => agent.status !== 'archived');
    const memberIds = snapshot.people.map((person) => person.principalId);
    const agent = agents.find((candidate) => candidate.principalId === request.principalId);
    if (agent === undefined) {
      return yield* new ConnectionsNotFound({ reason: 'Agent v této firmě neexistuje.' });
    }
    const catalog = yield* companyCatalog(legalEntityId, yield* roleTemplates(caller, transport), grants);
    const problem = agentDraftProblem({
      displayName: request.displayName,
      existingNames: agents.flatMap((other) => (other.principalId === agent.principalId ? [] : [other.displayName])),
      labelOf: catalog.labelOf,
      memberIds,
      modules: request.modules,
      operatorPrincipalIds: [],
      options: catalog.options,
      ownerPrincipalId: request.ownerPrincipalId,
    });
    if (problem !== null) {
      return yield* new ConnectionsInvalid({ reason: problem });
    }
    const result = yield* runtime
      .runAction({
        payload: {
          description: cleanDescription(request.description),
          displayName: request.displayName.trim(),
          modules: request.modules,
          operation: 'configure-agent',
          ownerPrincipalId: request.ownerPrincipalId,
          principalId: agent.principalId,
          writePolicy: request.writePolicy,
        },
        principal: caller.principal,
        registration: configureAgentAction,
        transport,
      })
      .pipe(
        Effect.catchTag('ActionAlreadyCommitted', () =>
          Effect.succeed({ principalId: agent.principalId, status: agent.status }),
        ),
        Effect.mapError(fromActionError),
      );
    const lifecycle = yield* ActionAuthorizationLifecycle;
    const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(unavailable));
    yield* lifecycle
      .reconcilePrincipal(tenantId, agent.principalId, installed.composition.revision)
      .pipe(Effect.mapError(unavailable));
    const configured: ManageAgentEntityResponse = {
      grantsGranted: 0,
      grantsRevoked: 0,
      operation: 'configure',
      principalId: agent.principalId,
      revokedConnections: 0,
      status: result.status === 'active' ? 'active' : 'disabled',
    };
    return configured;
  }

  if (request.operation === CHANGE_STATUS) {
    const reason = request.reason?.trim() ?? '';
    if (request.newStatus === 'disabled' && reason === '') {
      return yield* new ConnectionsInvalid({ reason: 'Uveďte důvod deaktivace.' });
    }
    if (request.newStatus === request.expectedStatus) {
      return yield* new ConnectionsInvalid({
        reason: request.newStatus === 'active' ? 'Agent už je aktivní.' : 'Agent už je deaktivovaný.',
      });
    }
    const payload: ManageAgentStatusPayload = {
      expectedStatus: request.expectedStatus,
      newStatus: request.newStatus,
      operation: CHANGE_STATUS,
      principalId: request.principalId,
    };
    yield* run(reason === '' ? payload : { ...payload, reason });
    const revokedConnections = request.newStatus === 'disabled' ? yield* revokeActive(request.principalId, reason) : 0;
    if (request.newStatus === 'disabled') {
      yield* withdrawProposals(request.principalId, `Agent byl deaktivován: ${reason}`);
    }
    const changed: ManageAgentEntityResponse = {
      grantsGranted: 0,
      grantsRevoked: 0,
      operation: CHANGE_STATUS,
      principalId: request.principalId,
      revokedConnections,
      status: request.newStatus,
    };
    return changed;
  }

  // A committed archive disappears from the governed directory. Only native same-key execution may confirm it;
  // neither target lookup nor expected-before state may be reconstructed from that disappearing projection.
  const reason = request.reason.trim();
  if (reason === '') {
    return yield* new ConnectionsInvalid({ reason: 'Uveďte důvod smazání.' });
  }
  yield* run({
    expectedStatus: request.expectedStatus,
    operation: 'archive-agent',
    principalId: request.principalId,
    reason,
  });
  const revokedConnections = yield* revokeActive(request.principalId, reason);
  yield* withdrawProposals(request.principalId, `Agent byl smazán: ${reason}`);
  const removed = yield* grants
    .replaceAgentGrants({ desired: [], legalEntityId, principalId: request.principalId, tenantId })
    .pipe(Effect.mapError(unavailable));
  yield* deps.directory.confirmArchived(request.principalId);
  const deleted: ManageAgentEntityResponse = {
    grantsGranted: 0,
    grantsRevoked: removed.revoked,
    operation: 'delete',
    principalId: request.principalId,
    revokedConnections,
    status: 'archived',
  };
  return deleted;
});

// Require both ingress identities before authority/lock resources; cleanup uses the original governed Read carrier.
export const manageAgentEntity = Effect.fn('AgentEntities.manageAgentEntity')(function* manageCompanyAgent<R>(
  caller: DemoAccountCaller,
  request: ManageAgentEntityRequest,
  deps: ConnectionsAdminDeps<R>,
) {
  yield* AgentActionRequestIdentity;
  yield* AgentReadRequestIdentity;
  const { legalEntityId, tenantId } = caller.principal;
  const grants = yield* openDemoAccountGrants.pipe(Effect.mapError(unavailable));
  yield* requireAdministrator(caller, grants).pipe(
    Effect.tapError((error) =>
      Predicate.isTagged(error, 'DemoAccountForbidden')
        ? auditForbiddenAttempt(
            caller,
            `${request.operation}-agent`,
            'agent',
            request.operation === 'create' ? null : request.principalId,
          )
        : Effect.void,
    ),
    Effect.mapError(fromDemoAccountError),
  );
  return yield* withCompanyAgentLock(tenantId, legalEntityId, changeAgent(caller, request, deps, grants));
}, Effect.scoped);
