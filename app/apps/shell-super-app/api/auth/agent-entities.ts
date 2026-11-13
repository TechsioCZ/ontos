/**
 * Agent entities of the selected company (Lidé a role › Agentní entity). The company administrator lists agents and
 * deactivates / reactivates and deletes them through the Core Action `core.identity.manage-agent-status`, with
 * sensitive audit. Deactivation and deletion revoke the agent's active OAuth connections at once and withdraw its
 * waiting proposals. Creating and configuring agents is not available in this release: an agent holds no authority on
 * Authorization v2 yet, so both are refused before any read. Changes of one company's agents run one at a time (a
 * private session advisory lock, without an open SQL transaction). Everything here reads PostgreSQL and the v2 intent;
 * no SpiceDB relation is read or written. Errors are Connections* errors with Czech reasons.
 */
import {
  ActionRuntime,
  manageAgentStatusAction,
  OperationalScopeResolver,
  TenantModuleStateService,
  withPostgresSessionAdvisoryLock,
} from '@app/core-runtime';
import type { ManageAgentStatusPayload, TrustedPrincipalContext } from '@app/core-runtime';
import { AccessProjectionWriter } from '@app/core-runtime/access/intent/projection-writer';
import { AccessPeopleCommands } from '@app/core-runtime/access/lifecycle/people-service';
import type {
  AgentEntity,
  ManageAgentEntityRequest,
  ManageAgentEntityResponse,
} from '@app/shared-contracts/agent-access';
import {
  AgentEntitySchema,
  AgentEntityOverviewSchema,
  AgentAuditEntrySchema,
} from '@app/shared-contracts/agent-access';
import { AgentLegalEntityIdSchema, AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { Effect, Match, Option, Predicate, Redacted, Schema } from 'effect';

import { composedModulesOf } from '../agent-platform/composed-modules.ts';
import { withdrawAllPendingOfAgent } from '../agent-platform/proposal-store.ts';
import { mcpModulesOf } from '../mcp/catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';

import { ConnectionsForbidden } from '../oauth-connections-admin/connections-forbidden.ts';
import { ConnectionsGone } from '../oauth-connections-admin/connections-gone.ts';
import { ConnectionsInvalid } from '../oauth-connections-admin/connections-invalid.ts';
import { ConnectionsUnavailable } from '../oauth-connections-admin/connections-unavailable.ts';
import type { ConnectionsAdminDeps } from '../oauth-connections-admin/ports.ts';
import { agentCatalogOf } from './agent-entities-model.ts';
import { auditForbiddenAttempt, auditTrail, requireAdministrator } from './demo-accounts.ts';
import { AgentActionRequestIdentity } from './agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from './agent-request-identity.ts';
import { AuthConfig } from './config.ts';
import type { DemoAccountCaller, DemoAccountForbidden } from './demo-accounts.ts';
import type { DemoAccountConflict } from './demo-account-conflict.ts';
import type { DemoAccountInvalid } from './demo-account-invalid.ts';
import type { DemoAccountUnavailable } from './demo-account-unavailable.ts';

const CHANGE_STATUS = 'change-status';
const unavailable = (cause: unknown) => new ConnectionsUnavailable({ cause });

/**
 * Authorization v2 retired the per-principal Action lifecycle: the one writer of the engine is the access
 * projection writer, which brings the whole tenant's projection in line with its intent. The reconcile is
 * idempotent, so a retry that already converged resumes instead of writing a second graph.
 */
const reconcileTenantProjection = Effect.fn('AgentEntities.reconcileTenantProjection')(
  function* reconcileTenantProjection(principal: TrustedPrincipalContext) {
    const { correlationId } = yield* AgentActionRequestIdentity;
    const resolver = yield* OperationalScopeResolver;
    const writer = yield* AccessProjectionWriter;
    const scope = yield* resolver.resolve({ correlationId, legalEntityScope: 'required', principal });
    yield* writer.reconcileTenant({ scope });
  },
  Effect.mapError(unavailable),
);

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

/** Creating or configuring an agent: refused in this release, before any read (agents hold no v2 authority yet). */
const AGENT_CHANGES_NOT_AVAILABLE = 'Vytváření a úpravy agentů nejsou v této verzi k dispozici.';

/**
 * The Agents page catalogue from the tenant's v2 intent, never a SpiceDB relation: the roles and the published release
 * the People page reads (`AccessPeopleCommands`), the tenant's active modules (`TenantModuleStateService`) and the
 * release's composition.
 */
export const companyCatalog = Effect.fn('AgentEntities.companyCatalog')(function* readCompanyCatalog(
  principal: DemoAccountCaller['principal'],
) {
  const { correlationId } = yield* AgentReadRequestIdentity;
  const scope = yield* (yield* OperationalScopeResolver)
    .resolve({ correlationId, legalEntityScope: 'required', principal })
    .pipe(Effect.mapError(unavailable));
  const people = yield* AccessPeopleCommands;
  const [view, capabilities] = yield* Effect.all([people.read(scope), people.readCatalog(scope)], {
    concurrency: 1,
  }).pipe(Effect.mapError(unavailable));
  const active = yield* (yield* TenantModuleStateService)
    .listActiveTenantModules(principal.tenantId)
    .pipe(Effect.mapError(unavailable));
  const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(unavailable));
  const composed = composedModulesOf(mcpModulesOf(installed.composition));
  return agentCatalogOf({
    activeModuleKeys: active.map(({ moduleKey }) => moduleKey),
    capabilities: capabilities.map(({ key, kind, moduleKey }) => ({ key, kind, moduleKey })),
    composedModuleKeys: composed.all.map(({ moduleId }) => moduleId),
    labelOf: composed.labelOf,
    legalEntityId: principal.legalEntityId,
    roles: view.roles.map(({ revision, role }) => ({
      capabilityKeys: revision.cells.map(({ capabilityKey }) => capabilityKey),
      id: role.id,
      legalEntityId: role.legalEntityId ?? null,
      name: role.name,
    })),
  });
});

export const listAgentEntities = Effect.fn('AgentEntities.listAgentEntities')(function* readAgentEntities<R>(
  caller: DemoAccountCaller,
  deps: ConnectionsAdminDeps<R>,
) {
  const transport = yield* AgentReadRequestIdentity;
  const { legalEntityId, tenantId } = caller.principal;
  yield* requireAdministrator(caller).pipe(
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
  const [catalog, { agents, audit, people }] = yield* Effect.all([companyCatalog(caller.principal), company], {
    concurrency: 2,
  });
  // Connection summaries have their own live-authority reads; do not overlap them with role/operator fan-out.
  const active = yield* deps.grants.list({ legalEntityId, statuses: ['active'], tenantId });
  const entries = agents.map((agent): AgentEntity =>
    AgentEntitySchema.make({
      connections: active.filter((connection) => connection.acting.principalId === agent.principalId),
      description: Option.fromNullOr(agent.description),
      displayName: agent.displayName,
      hasProfile: agent.hasProfile,
      modules: agent.modules,
      operators: people.filter((person) => agent.operatorPrincipalIds.includes(person.principalId)),
      operatorsRevision: agent.operatorCommand?.revision ?? 0,
      owner: Option.fromUndefinedOr(people.find((person) => person.principalId === agent.ownerPrincipalId)),
      principalId: AgentPrincipalIdSchema.make(agent.principalId),
      status: agent.status,
      writePolicy: agent.writePolicy,
    }),
  );
  const decodedAudit = yield* Schema.decodeEffect(Schema.Array(AgentAuditEntrySchema))(audit).pipe(
    Effect.mapError(unavailable),
  );
  const overview = AgentEntityOverviewSchema.make({
    agents: entries,
    audit: decodedAudit,
    company: { legalEntityId: AgentLegalEntityIdSchema.make(legalEntityId), legalName: caller.legalName },
    members: people,
    modules: catalog.options,
    presets: catalog.presets,
  });
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
  request: Exclude<ManageAgentEntityRequest, { readonly operation: 'configure' | 'create' }>,
  deps: ConnectionsAdminDeps<R>,
) {
  const transport = yield* AgentActionRequestIdentity;
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
    yield* reconcileTenantProjection(caller.principal);
  });
  const revokeActive = (agentPrincipalId: string, reasonText: string) =>
    revokeAgentConnections(caller, deps, agentPrincipalId, reasonText);
  // Status first, then cleanup (O43): the status change commits on its own, and a failed withdrawal answers a
  // retryable 503. The client retries the exact command with its original key; the native same-key run confirms
  // the committed status (ActionAlreadyCommitted) and resumes this cleanup, so nothing is left half done for good.
  const withdrawProposals = (agentPrincipalId: string, note: string) =>
    withdrawAllPendingOfAgent(caller.principal, { agentPrincipalId, note }).pipe(
      Effect.tapError(() =>
        Effect.logWarning('Agent status committed; proposal withdrawal pending a same-key retry').pipe(
          Effect.annotateLogs({ agentPrincipal: agentPrincipalId, operation: request.operation }),
        ),
      ),
      Effect.mapError(unavailable),
    );

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
  yield* deps.directory.confirmArchived(request.principalId);
  const deleted: ManageAgentEntityResponse = {
    grantsGranted: 0,
    grantsRevoked: 0,
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
  yield* requireAdministrator(caller).pipe(
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
  if (request.operation === 'create' || request.operation === 'configure') {
    return yield* new ConnectionsInvalid({ reason: AGENT_CHANGES_NOT_AVAILABLE });
  }
  return yield* withCompanyAgentLock(tenantId, legalEntityId, changeAgent(caller, request, deps));
}, Effect.scoped);
