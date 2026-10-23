/**
 * Agent entities of the selected company (Lidé a role › Agentní entity). The company administrator lists, creates,
 * configures, deactivates / reactivates and deletes agents. Every change runs the Core Action
 * `core.identity.manage-demo-account` (create-agent / configure-agent / change-status / delete (archives the principal), sensitive
 * audit); then its company-scoped role policy is rebuilt from the selected module access and write policy,
 * and its operators are written with principal#tenant. Deactivation and deletion revoke the agent's active OAuth
 * connections at once and withdraw its waiting proposals. Changes of one company's agents run one at a time
 * (a private session advisory lock, without an open SQL transaction), so two parallel creates cannot both pass the
 * unique-name check. No tokens or API keys: agents connect only through the OAuth consent ('Za agenta'). Errors are
 * Connections* errors with Czech reasons.
 */
import {
  ActionRuntime,
  agentGrantRelationships,
  agentModuleAccessOf,
  manageDemoAccountAction,
  openDemoAccountGrants,
  withPostgresSessionAdvisoryLock,
} from '@app/core-runtime';
import type { DemoAccountGrants, ManageDemoAccountPayload } from '@app/core-runtime';
import type {
  AgentEntity,
  AgentEntityOverview,
  ManageAgentEntityRequest,
  ManageAgentEntityResponse,
} from '@app/shared-contracts/agent-access';
import { AgentModuleGrantSchema } from '@app/shared-contracts/agent-access';
import { Effect, Redacted, Schema } from 'effect';

import { composedModulesOf } from '../agent-platform/composed-modules.ts';
import { withdrawPendingOfAgent } from '../agent-platform/proposal-store.ts';
import { mcpModulesOf } from '../mcp/catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';

import {
  ConnectionsForbidden,
  ConnectionsGone,
  ConnectionsInvalid,
  ConnectionsNotFound,
  ConnectionsUnavailable,
} from '../oauth-connections-admin/ports.ts';
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
import { AuthConfig } from './config.ts';
import type {
  DemoAccountCaller,
  DemoAccountConflict,
  DemoAccountForbidden,
  DemoAccountInvalid,
  DemoAccountUnavailable,
} from './demo-accounts.ts';

const unavailable = (cause: unknown) => new ConnectionsUnavailable({ cause });

const fromDemoAccountError = (
  error: DemoAccountConflict | DemoAccountForbidden | DemoAccountInvalid | DemoAccountUnavailable,
) => {
  switch (error._tag) {
    case 'DemoAccountForbidden':
      return new ConnectionsForbidden({ reason: 'Agenty spravuje jen správce firmy. Pokus je zapsaný v auditu.' });
    case 'DemoAccountInvalid':
      return new ConnectionsInvalid({ reason: 'Tuto změnu agenta nelze provést.' });
    case 'DemoAccountConflict':
      return new ConnectionsGone({ reason: 'Agent se mezitím změnil. Obnovte seznam.' });
    default:
      return new ConnectionsUnavailable({ cause: error.cause });
  }
};

const fromActionError = (error: { readonly _tag: string }) => {
  switch (error._tag) {
    case 'IdentityLifecycleConflictError':
    case 'ActionRequestHashConflict':
      return new ConnectionsGone({ reason: 'Agent se mezitím změnil. Obnovte seznam a zkuste to znovu.' });
    case 'IdentityTargetInvalidError':
    case 'ActionPayloadValidationError':
      return new ConnectionsInvalid({ reason: 'Tuto změnu agenta nelze provést.' });
    case 'ActionPermissionDenied':
    case 'ActionPolicyDenied':
      return new ConnectionsForbidden({ reason: 'K této změně nemáte oprávnění. Pokus je zapsaný v auditu.' });
    default:
      return new ConnectionsUnavailable({ cause: error });
  }
};

const ModulesJson = Schema.fromJsonString(Schema.Array(AgentModuleGrantSchema));
const modulesJsonOf = Schema.encodeSync(ModulesJson);

const cleanDescription = (value: string | null) => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

const roleTemplates = (tenantId: string, legalEntityId: string) =>
  companyRoleTemplates(tenantId, legalEntityId).pipe(Effect.mapError(fromDemoAccountError));

export const companyCatalog = (
  legalEntityId: string,
  roles: Effect.Success<ReturnType<typeof roleTemplates>>,
  grants: Pick<DemoAccountGrants, 'relationshipsOf'>,
) =>
  Effect.gen(function* companyCatalog() {
    // relationshipsOf opens two gateway reads per principal. Two roles plus one operator read leave the sixth
    // Worker connection for PostgreSQL. Unbounded fan-out can cancel a queued fetch before it makes progress.
    const templates = yield* Effect.forEach(
      roles,
      (role) =>
        grants.relationshipsOf(role.templatePrincipalId).pipe(Effect.map((relationships) => ({ relationships, role }))),
      { concurrency: 2 },
    ).pipe(Effect.mapError(unavailable));
    const union = templates.flatMap(({ relationships }) => relationships);
    const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(unavailable));
    const labelOf = composedModulesOf(mcpModulesOf(installed.composition)).labelOf;
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

export const listAgentEntities = <R>(caller: DemoAccountCaller, deps: ConnectionsAdminDeps<R>) =>
  Effect.gen(function* listAgentEntities() {
    const { legalEntityId, tenantId } = caller.principal;
    const grants = yield* openDemoAccountGrants.pipe(Effect.mapError(unavailable));
    const { members } = yield* requireAdministrator(caller, grants).pipe(
      Effect.mapError((error) =>
        error._tag === 'DemoAccountForbidden'
          ? new ConnectionsForbidden({ reason: 'Agenty spravuje jen správce firmy.' })
          : fromDemoAccountError(error),
      ),
    );
    // Every SpiceDB read is a Workers VPC round trip, so the role templates and the agents' operators are read
    // concurrently. Database reads stay on one sequential lane: a pooled connection holds one of the six
    // outbound-connection slots of the request until it ends.
    const company = Effect.gen(function* companyAgents() {
      // Agents someone answers for first (the ones the company set up), then technical ones without an owner.
      const agents = (yield* deps.directory.agents(tenantId, members))
        .filter((agent) => agent.status !== 'archived')
        .toSorted((left, right) => Number(left.ownerPrincipalId === null) - Number(right.ownerPrincipalId === null));
      const [operators, [people, audit]] = yield* Effect.all(
        [
          Effect.forEach(agents, (agent) => deps.directory.operatorsOf(agent.principalId), { concurrency: 1 }),
          Effect.all(
            [
              deps.directory.people(tenantId, members),
              auditTrail(tenantId, legalEntityId, [], 'agents').pipe(Effect.mapError(fromDemoAccountError)),
            ],
            { concurrency: 1 },
          ),
        ],
        { concurrency: 2 },
      );
      return { agents, audit, operators, people };
    });
    const roles = yield* roleTemplates(tenantId, legalEntityId);
    const [catalog, { agents, audit, operators, people }] = yield* Effect.all(
      [companyCatalog(legalEntityId, roles, grants), company],
      { concurrency: 2 },
    );
    // Connection summaries have their own live-authority reads; do not overlap them with role/operator fan-out.
    const active = yield* deps.grants.list({ legalEntityId, statuses: ['active'], tenantId });
    const entries = agents.map((agent, index): AgentEntity => ({
      connections: active.filter((connection) => connection.acting.principalId === agent.principalId),
      description: agent.description,
      displayName: agent.displayName,
      modules: agent.modules,
      operators: people.filter((person) => operators[index]?.includes(person.principalId) === true),
      owner: people.find((person) => person.principalId === agent.ownerPrincipalId) ?? null,
      principalId: agent.principalId,
      seeded: agent.seeded,
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
  }).pipe(Effect.scoped);

/** Serialize company agent changes without keeping a SQL transaction open across external effects. */
const withCompanyAgentLock = <A, E, R>(tenantId: string, legalEntityId: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* withCompanyAgentLock() {
    const configuration = yield* AuthConfig;
    return yield* withPostgresSessionAdvisoryLock(
      Redacted.make(configuration.connectionString),
      `agent-entities:${tenantId}:${legalEntityId}`,
      effect,
    ).pipe(Effect.catchTag('SessionAdvisoryLockUnavailable', (error) => Effect.fail(unavailable(error))));
  });

const changeAgent = <R>(
  caller: DemoAccountCaller,
  request: ManageAgentEntityRequest,
  transport: { readonly correlationId: string; readonly idempotencyKey: string },
  deps: ConnectionsAdminDeps<R>,
  grants: DemoAccountGrants,
) =>
  Effect.gen(function* changeAgent() {
    const { legalEntityId, principalId: actorPrincipalId, tenantId } = caller.principal;
    const runtime = yield* ActionRuntime;
    const run = (payload: ManageDemoAccountPayload) =>
      runtime
        .runAction({ payload, principal: caller.principal, registration: manageDemoAccountAction, transport })
        .pipe(Effect.mapError(fromActionError));
    const members = yield* deps.directory.members(tenantId, legalEntityId);
    const agents = (yield* deps.directory.agents(tenantId, members)).filter((agent) => agent.status !== 'archived');
    const memberIds = (yield* deps.directory.people(tenantId, members)).map((person) => person.principalId);
    const revokeActive = (agentPrincipalId: string, reasonText: string) =>
      deps.grants.list({ actingPrincipalId: agentPrincipalId, legalEntityId, statuses: ['active'], tenantId }).pipe(
        Effect.flatMap((connections) =>
          Effect.forEach(
            connections,
            (connection) =>
              deps.grants.revoke({
                actorPrincipalId,
                grantId: connection.grantId,
                reasonCode: 'admin',
                reasonText,
              }),
            { discard: true },
          ).pipe(Effect.as(connections.length)),
        ),
      );
    const withdrawProposals = (agentPrincipalId: string, note: string) =>
      withdrawPendingOfAgent({ agentPrincipalId, by: actorPrincipalId, legalEntityId, note, tenantId }).pipe(
        Effect.mapError(unavailable),
      );

    if (request.operation === 'create') {
      // Same idempotency key = same principal id: a retry replays the Core Action instead of failing the name check.
      const principalId = derivedUuid(`${tenantId}:${legalEntityId}:${transport.idempotencyKey}:agent`);
      const catalog = yield* companyCatalog(legalEntityId, yield* roleTemplates(tenantId, legalEntityId), grants);
      const problem = agentDraftProblem({
        labelOf: catalog.labelOf,
        displayName: request.displayName,
        existingNames: agents.filter((agent) => agent.principalId !== principalId).map((agent) => agent.displayName),
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
            modulesJson: modulesJsonOf(request.modules),
            operation: 'create-agent',
            ownerPrincipalId: request.ownerPrincipalId,
            principalId,
            writePolicy: request.writePolicy,
          },
          principal: caller.principal,
          registration: manageDemoAccountAction,
          transport,
        })
        .pipe(
          Effect.catchTag('ActionAlreadyCommitted', () => Effect.succeed({ principalId })),
          Effect.mapError(fromActionError),
        );
      const written = yield* grants
        .replaceAgentGrants({
          desired: agentGrantRelationships({
            actions: catalog.actions,
            legalEntityId,
            legalEntityWriteRelations: catalog.legalEntityWriteRelations,
            modules: request.modules,
            principalId: result.principalId,
            template: catalog.union,
            tenantId,
            writePolicy: request.writePolicy,
          }),
          legalEntityId,
          principalId: result.principalId,
          tenantId,
        })
        .pipe(Effect.mapError(unavailable));
      yield* deps.directory.replaceOperators({
        actorPrincipalId,
        agentPrincipalId: result.principalId,
        context: 'agent-created',
        legalEntityId,
        operatorPrincipalIds: [...new Set(request.operatorPrincipalIds)],
        revokedConnections: 0,
        tenantId,
      });
      const created: ManageAgentEntityResponse = {
        grantsGranted: written.granted,
        grantsRevoked: written.revoked,
        operation: 'create',
        principalId: result.principalId,
        revokedConnections: 0,
        status: 'active',
      };
      return created;
    }

    const agent = agents.find((candidate) => candidate.principalId === request.principalId);
    if (agent === undefined) {
      return yield* new ConnectionsNotFound({ reason: 'Agent v této firmě neexistuje.' });
    }

    if (request.operation === 'configure') {
      const catalog = yield* companyCatalog(legalEntityId, yield* roleTemplates(tenantId, legalEntityId), grants);
      const problem = agentDraftProblem({
        labelOf: catalog.labelOf,
        displayName: request.displayName,
        existingNames: agents
          .filter((other) => other.principalId !== agent.principalId)
          .map((other) => other.displayName),
        memberIds,
        modules: request.modules,
        operatorPrincipalIds: [],
        options: catalog.options,
        ownerPrincipalId: request.ownerPrincipalId,
      });
      if (problem !== null) {
        return yield* new ConnectionsInvalid({ reason: problem });
      }
      const result = yield* run({
        description: cleanDescription(request.description),
        displayName: request.displayName.trim(),
        modulesJson: modulesJsonOf(request.modules),
        operation: 'configure-agent',
        ownerPrincipalId: request.ownerPrincipalId,
        previousModulesJson: modulesJsonOf(agent.modules),
        previousWritePolicy: agent.writePolicy,
        principalId: agent.principalId,
        writePolicy: request.writePolicy,
      });
      const written = yield* grants
        .replaceAgentGrants({
          desired: agentGrantRelationships({
            actions: catalog.actions,
            legalEntityId,
            legalEntityWriteRelations: catalog.legalEntityWriteRelations,
            modules: request.modules,
            principalId: agent.principalId,
            template: catalog.union,
            tenantId,
            writePolicy: request.writePolicy,
          }),
          legalEntityId,
          principalId: agent.principalId,
          tenantId,
        })
        .pipe(Effect.mapError(unavailable));
      const configured: ManageAgentEntityResponse = {
        grantsGranted: written.granted,
        grantsRevoked: written.revoked,
        operation: 'configure',
        principalId: agent.principalId,
        revokedConnections: 0,
        status: result.status === 'active' ? 'active' : 'disabled',
      };
      return configured;
    }

    if (request.operation === 'change-status') {
      const reason = request.reason?.trim() ?? '';
      if (request.newStatus === 'disabled' && reason === '') {
        return yield* new ConnectionsInvalid({ reason: 'Uveďte důvod deaktivace.' });
      }
      if (agent.status !== request.expectedStatus) {
        return yield* new ConnectionsGone({ reason: 'Stav agenta se mezitím změnil. Obnovte seznam.' });
      }
      if (request.newStatus === request.expectedStatus) {
        return yield* new ConnectionsInvalid({
          reason: request.newStatus === 'active' ? 'Agent už je aktivní.' : 'Agent už je deaktivovaný.',
        });
      }
      yield* run({
        expectedStatus: request.expectedStatus,
        newStatus: request.newStatus,
        operation: 'change-status',
        principalId: agent.principalId,
        ...(reason === '' ? {} : { reason }),
      });
      const revokedConnections = request.newStatus === 'disabled' ? yield* revokeActive(agent.principalId, reason) : 0;
      if (request.newStatus === 'disabled') {
        yield* withdrawProposals(agent.principalId, `Agent byl deaktivován: ${reason}`);
      }
      const changed: ManageAgentEntityResponse = {
        grantsGranted: 0,
        grantsRevoked: 0,
        operation: 'change-status',
        principalId: agent.principalId,
        revokedConnections,
        status: request.newStatus,
      };
      return changed;
    }

    // delete
    const reason = request.reason.trim();
    if (reason === '') {
      return yield* new ConnectionsInvalid({ reason: 'Uveďte důvod smazání.' });
    }
    yield* run({
      expectedStatus: agent.status === 'active' ? 'active' : 'disabled',
      operation: 'archive-agent',
      principalId: agent.principalId,
      reason,
    });
    const revokedConnections = yield* revokeActive(agent.principalId, reason);
    yield* withdrawProposals(agent.principalId, `Agent byl smazán: ${reason}`);
    const removed = yield* grants
      .replaceAgentGrants({ desired: [], legalEntityId, principalId: agent.principalId, tenantId })
      .pipe(Effect.mapError(unavailable));
    yield* deps.directory.replaceOperators({
      actorPrincipalId,
      agentPrincipalId: agent.principalId,
      context: 'agent-deleted',
      legalEntityId,
      operatorPrincipalIds: [],
      revokedConnections: 0,
      tenantId,
    });
    const deleted: ManageAgentEntityResponse = {
      grantsGranted: 0,
      grantsRevoked: removed.revoked,
      operation: 'delete',
      principalId: agent.principalId,
      revokedConnections,
      status: 'archived',
    };
    return deleted;
  });

export const manageAgentEntity = <R>(
  caller: DemoAccountCaller,
  request: ManageAgentEntityRequest,
  transport: { readonly correlationId: string; readonly idempotencyKey: string },
  deps: ConnectionsAdminDeps<R>,
) =>
  Effect.gen(function* manageAgentEntity() {
    const { legalEntityId, tenantId } = caller.principal;
    const grants = yield* openDemoAccountGrants.pipe(Effect.mapError(unavailable));
    yield* requireAdministrator(caller, grants).pipe(
      Effect.tapError((error) =>
        error._tag === 'DemoAccountForbidden'
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
    return yield* withCompanyAgentLock(tenantId, legalEntityId, changeAgent(caller, request, transport, deps, grants));
  }).pipe(Effect.scoped);
