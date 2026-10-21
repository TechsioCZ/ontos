/**
 * Agent entities of the selected company (Lidé a role › Agentní entity). The company administrator lists, creates,
 * configures, deactivates / reactivates and deletes agents. Every change runs the Core Action
 * `core.identity.manage-demo-account` (create-agent / configure-agent / change-status / delete (archives the principal), sensitive
 * audit); then the agent's SpiceDB grants are rebuilt from the company's role templates (same relationships human
 * roles use, `agentGrantRelationships`) and its operators are written with principal#tenant. Deactivation and
 * deletion revoke the agent's active OAuth connections at once. No tokens or API keys: agents connect only through
 * the OAuth consent ('Za agenta'). Errors are Connections* errors with Czech reasons.
 */
import {
  ActionRuntime,
  agentGrantRelationships,
  agentModuleAccessOf,
  manageDemoAccountAction,
  openDemoAccountGrants,
} from '@app/core-runtime';
import type { DemoAccountGrants, ManageDemoAccountPayload } from '@app/core-runtime';
import type {
  AgentEntity,
  AgentEntityOverview,
  ManageAgentEntityRequest,
  ManageAgentEntityResponse,
} from '@app/shared-contracts/agent-access';
import { AgentModuleGrantSchema } from '@app/shared-contracts/agent-access';
import { Effect, Schema } from 'effect';

import {
  ConnectionsForbidden,
  ConnectionsGone,
  ConnectionsInvalid,
  ConnectionsNotFound,
  ConnectionsUnavailable,
} from '../oauth-connections-admin/ports.ts';
import type { ConnectionsAdminDeps } from '../oauth-connections-admin/ports.ts';
import { agentDraftProblem, agentModuleOptions, agentRolePreset } from './agent-entities-model.ts';
import {
  auditForbiddenAttempt,
  auditTrail,
  companyRoleTemplates,
  derivedUuid,
  requireAdministrator,
} from './demo-accounts.ts';
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

const companyCatalog = (tenantId: string, legalEntityId: string, grants: DemoAccountGrants) =>
  Effect.gen(function* companyCatalog() {
    const roles = yield* companyRoleTemplates(tenantId, legalEntityId).pipe(Effect.mapError(fromDemoAccountError));
    const templates = yield* Effect.forEach(
      roles,
      (role) =>
        grants.relationshipsOf(role.templatePrincipalId).pipe(Effect.map((relationships) => ({ relationships, role }))),
      { concurrency: 3 },
    ).pipe(Effect.mapError(unavailable));
    const union = templates.flatMap(({ relationships }) => relationships);
    return {
      options: agentModuleOptions(agentModuleAccessOf(union, legalEntityId)),
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
    yield* requireAdministrator(caller, grants).pipe(Effect.mapError(fromDemoAccountError));
    const catalog = yield* companyCatalog(tenantId, legalEntityId, grants);
    const agents = (yield* deps.directory.agents(tenantId, legalEntityId)).filter(
      (agent) => agent.status !== 'archived',
    );
    const people = yield* deps.directory.people(tenantId, legalEntityId);
    const active = yield* deps.grants.list({ legalEntityId, statuses: ['active'], tenantId });
    const entries = yield* Effect.forEach(agents, (agent) =>
      deps.directory.operatorsOf(agent.principalId).pipe(
        Effect.map((operatorIds): AgentEntity => ({
          connections: active.filter((connection) => connection.acting.principalId === agent.principalId),
          description: agent.description,
          displayName: agent.displayName,
          modules: agent.modules,
          operators: people.filter((person) => operatorIds.includes(person.principalId)),
          owner: people.find((person) => person.principalId === agent.ownerPrincipalId) ?? null,
          principalId: agent.principalId,
          seeded: agent.seeded,
          status: agent.status,
          writePolicy: agent.writePolicy,
        })),
      ),
    );
    const audit = yield* auditTrail(tenantId, legalEntityId, [], 'agents').pipe(Effect.mapError(fromDemoAccountError));
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

export const manageAgentEntity = <R>(
  caller: DemoAccountCaller,
  request: ManageAgentEntityRequest,
  transport: { readonly correlationId: string; readonly idempotencyKey: string },
  deps: ConnectionsAdminDeps<R>,
) =>
  Effect.gen(function* manageAgentEntity() {
    const { legalEntityId, principalId: actorPrincipalId, tenantId } = caller.principal;
    const grants = yield* openDemoAccountGrants.pipe(Effect.mapError(unavailable));
    yield* requireAdministrator(caller, grants).pipe(
      Effect.tapError((error) =>
        error._tag === 'DemoAccountForbidden'
          ? auditForbiddenAttempt(caller, `${request.operation}-agent`, 'agent')
          : Effect.void,
      ),
      Effect.mapError(fromDemoAccountError),
    );
    const runtime = yield* ActionRuntime;
    const run = (payload: ManageDemoAccountPayload) =>
      runtime
        .runAction({ payload, principal: caller.principal, registration: manageDemoAccountAction, transport })
        .pipe(Effect.mapError(fromActionError));
    const agents = (yield* deps.directory.agents(tenantId, legalEntityId)).filter(
      (agent) => agent.status !== 'archived',
    );
    const memberIds = (yield* deps.directory.people(tenantId, legalEntityId)).map((person) => person.principalId);
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

    if (request.operation === 'create') {
      const catalog = yield* companyCatalog(tenantId, legalEntityId, grants);
      const problem = agentDraftProblem({
        displayName: request.displayName,
        existingNames: agents.map((agent) => agent.displayName),
        memberIds,
        modules: request.modules,
        operatorPrincipalIds: request.operatorPrincipalIds,
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
        operation: 'create-agent',
        ownerPrincipalId: request.ownerPrincipalId,
        principalId: derivedUuid(`${tenantId}:${legalEntityId}:${transport.idempotencyKey}:agent`),
        writePolicy: request.writePolicy,
      });
      const written = yield* grants
        .replaceAgentGrants({
          desired: agentGrantRelationships({
            legalEntityId,
            modules: request.modules,
            template: catalog.union,
            writePolicy: request.writePolicy,
          }),
          principalId: result.principalId,
        })
        .pipe(Effect.mapError(unavailable));
      yield* deps.directory.replaceOperators({
        actorPrincipalId,
        agentPrincipalId: result.principalId,
        legalEntityId,
        operatorPrincipalIds: [...new Set(request.operatorPrincipalIds)],
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
      const catalog = yield* companyCatalog(tenantId, legalEntityId, grants);
      const problem = agentDraftProblem({
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
            legalEntityId,
            modules: request.modules,
            template: catalog.union,
            writePolicy: request.writePolicy,
          }),
          principalId: agent.principalId,
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
    const removed = yield* grants
      .replaceAgentGrants({ desired: [], principalId: agent.principalId })
      .pipe(Effect.mapError(unavailable));
    yield* deps.directory.replaceOperators({
      actorPrincipalId,
      agentPrincipalId: agent.principalId,
      legalEntityId,
      operatorPrincipalIds: [],
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
  }).pipe(Effect.scoped);
