/**
 * Agent entities of the selected company (Lidé a role › AI agenti). The company administrator lists, creates,
 * configures, deactivates / reactivates and deletes agents, and gives them roles. Profile and status changes run the
 * Core Actions `core.identity.configure-agent` and `core.identity.manage-agent-status`, with sensitive audit. Rights
 * come only from roles: a role is assigned and removed through the People page's own commands, rules and audit (the
 * agent is the holder), and the overview shows what the agent can actually use of them. Deactivation and deletion
 * revoke the agent's active OAuth connections at once and withdraw its waiting proposals. Changes of one company's
 * agents run one at a time (a private session advisory lock, without an open SQL transaction), so two parallel creates
 * cannot both pass the unique-name check. Agents connect only through the OAuth consent ('Za agenta'). Errors are
 * Connections* errors with Czech reasons.
 */
import {
  ActionRuntime,
  manageAgentStatusAction,
  configureAgentAction,
  OperationalScopeResolver,
  withPostgresSessionAdvisoryLock,
} from '@app/core-runtime';
import type { ManageAgentStatusPayload, TrustedPrincipalContext } from '@app/core-runtime';
import { AgentIdSchema } from '@app/core-runtime/access/ids';
import { AccessProjectionWriter } from '@app/core-runtime/access/intent/projection-writer';
import { agentUsableCapabilities } from '@app/core-runtime/access/lifecycle/agent-authority';
import type {
  AgentEntity,
  ManageAgentEntityRequest,
  ManageAgentEntityResponse,
} from '@app/shared-contracts/agent-access';
import {
  AgentAssignmentIdSchema,
  AgentEntitySchema,
  AgentEntityOverviewSchema,
  AgentAuditEntrySchema,
  AgentRoleIdSchema,
  AgentRoleRevisionIdSchema,
} from '@app/shared-contracts/agent-access';
import { AgentLegalEntityIdSchema, AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { Effect, Match, Option, Predicate, Redacted, Schema } from 'effect';

import type { AccessAdminProblem } from '../../shared/access-admin-api.ts';
import { AccessPeopleBff } from '../access-admin/people.ts';
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
import { agentAdministrationDecision } from './administration-access.ts';
import { agentDraftProblem, usableModulesOf } from './agent-entities-model.ts';
import { auditForbiddenAttempt, auditTrail, derivedUuid } from './demo-accounts.ts';
import { AgentActionRequestIdentity } from './agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from './agent-request-identity.ts';
import { AuthConfig } from './config.ts';
import type { DemoAccountCaller, DemoAccountForbidden } from './demo-accounts.ts';
import type { DemoAccountConflict } from './demo-account-conflict.ts';
import type { DemoAccountInvalid } from './demo-account-invalid.ts';
import type { DemoAccountUnavailable } from './demo-account-unavailable.ts';

const CHANGE_STATUS = 'change-status';
const AGENT_NOT_FOUND = 'Agent v této firmě neexistuje.';
const ASSIGN_ROLE = 'assign-role';
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

const cleanDescription = (value: Option.Option<string>) => {
  const trimmed = Option.getOrElse(value, () => '').trim();
  return trimmed === '' ? null : trimmed;
};

/** Agent administration is one right in the caller's company (`core.identity.agent-status.manage`), asked of the gate. */
const requireAgentAdministrator = Effect.fn('AgentEntities.requireAgentAdministrator')(function* requireAdmin(
  caller: DemoAccountCaller,
) {
  const decision = yield* agentAdministrationDecision(caller.principal).pipe(Effect.mapError(unavailable));
  if (decision.outcome === 'UNAVAILABLE') {
    return yield* unavailable('Agent administration authority is temporarily unavailable');
  }
  return decision.outcome === 'ALLOWED'
    ? undefined
    : yield* new ConnectionsForbidden({ reason: 'Agenty spravuje jen správce firmy. Pokus je zapsaný v auditu.' });
});

/** A People refusal as the agents page names it: the People rule decided it, in Czech. */
const fromPeopleProblem = (problem: AccessAdminProblem) =>
  Match.value(problem._tag).pipe(
    Match.when(
      'AccessAdminForbidden',
      () => new ConnectionsForbidden({ reason: 'Tuto roli agentovi přidělit ani odebrat nesmíte.' }),
    ),
    Match.when('AccessAdminAuthenticationRequired', () => new ConnectionsForbidden({ reason: 'Přihlaste se znovu.' })),
    Match.when(
      'AccessAdminConflict',
      () => new ConnectionsGone({ reason: 'Role nebo agent se mezitím změnily. Obnovte seznam a zkuste to znovu.' }),
    ),
    Match.whenOr(
      'AccessAdminUnprocessable',
      'AccessAdminInvalidRequest',
      () => new ConnectionsInvalid({ reason: 'Tuto roli agentovi přidělit nelze.' }),
    ),
    Match.orElse(() => unavailable(problem)),
  );

/** Installed modules with their labels: only these are named in what an agent can use. */
const installedModules = Effect.gen(function* installedModulesOf() {
  const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(unavailable));
  const composed = mcpModulesOf(installed.composition);
  return {
    ids: new Set<string>(composed.modules.map((module) => module.moduleId)),
    labelOf: composedModulesOf(composed).labelOf,
  };
});

export const listAgentEntities = Effect.fn('AgentEntities.listAgentEntities')(function* readAgentEntities<R>(
  caller: DemoAccountCaller,
  headers: Headers,
  deps: ConnectionsAdminDeps<R>,
) {
  const transport = yield* AgentReadRequestIdentity;
  const { legalEntityId, tenantId } = caller.principal;
  yield* requireAgentAdministrator(caller);
  const snapshot = yield* deps.directory.snapshot;
  // Agents someone answers for first, then technical ones without an owner.
  const agents = snapshot.agents
    .filter((agent) => agent.status !== 'archived')
    .toSorted((left, right) => Number(left.ownerPrincipalId === null) - Number(right.ownerPrincipalId === null));
  // The roles come from the People page's own read and reach; what an agent can use is the engine's agent rule.
  // The three reads are independent; each holds a database connection, so they run one at a time.
  const people = yield* AccessPeopleBff;
  const [audit, roles, modules] = yield* Effect.all(
    [
      auditTrail(caller, transport, 'agents').pipe(Effect.mapError(fromDemoAccountError)),
      people
        .agentRoles(headers, { agentPrincipalIds: agents.map((agent) => agent.principalId), legalEntityId })
        .pipe(Effect.mapError(fromPeopleProblem)),
      installedModules,
    ],
    { concurrency: 1 },
  );
  // Connection summaries have their own live-authority reads; do not overlap them with the reads above.
  const active = yield* deps.grants.list({ legalEntityId, statuses: ['active'], tenantId });
  const entries = agents.map((agent): AgentEntity => {
    const held = roles.agents.get(agent.principalId);
    const usable = agentUsableCapabilities(held?.cells ?? [], roles.catalog).map(({ entry, use }) => ({
      kind: entry.kind,
      moduleKey: entry.moduleKey,
      use,
    }));
    return AgentEntitySchema.make({
      connections: active.filter((connection) => connection.acting.principalId === agent.principalId),
      description: Option.fromNullOr(agent.description),
      displayName: agent.displayName,
      hasProfile: agent.hasProfile,
      operators: snapshot.people.filter((person) => agent.operatorPrincipalIds.includes(person.principalId)),
      operatorsRevision: agent.operatorCommand?.revision ?? 0,
      owner: Option.fromUndefinedOr(snapshot.people.find((person) => person.principalId === agent.ownerPrincipalId)),
      principalId: AgentPrincipalIdSchema.make(agent.principalId),
      roles: (held?.assignments ?? []).map((assignment) => ({
        assignmentId: AgentAssignmentIdSchema.make(assignment.incarnationId),
        name: assignment.roleName,
        roleId: AgentRoleIdSchema.make(assignment.roleId),
      })),
      status: agent.status,
      usable: usableModulesOf(usable, modules.labelOf, modules.ids),
      writePolicy: agent.writePolicy,
    });
  });
  const decodedAudit = yield* Schema.decodeEffect(Schema.Array(AgentAuditEntrySchema))(audit).pipe(
    Effect.mapError(unavailable),
  );
  return AgentEntityOverviewSchema.make({
    agents: entries,
    audit: decodedAudit,
    company: { legalEntityId: AgentLegalEntityIdSchema.make(legalEntityId), legalName: caller.legalName },
    members: snapshot.people,
    roles: roles.roles
      .map((role) => ({
        name: role.name,
        roleId: AgentRoleIdSchema.make(role.roleId),
        roleRevisionId: AgentRoleRevisionIdSchema.make(role.revisionId),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name, 'cs')),
    rolesRevision: roles.revision,
  });
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

/**
 * Gives an agent a company role or takes one away, through the People page's own commands, rules and audit: the
 * agent is the holder. Whoever may not assign that role to a person in this company may not assign it to an agent.
 */
const changeAgentRole = Effect.fn('AgentEntities.changeAgentRole')(function* changeAgentRole<R>(input: {
  readonly deps: ConnectionsAdminDeps<R>;
  readonly headers: Headers;
  readonly idempotencyKey: string;
  readonly legalEntityId: string;
  readonly request: Extract<ManageAgentEntityRequest, { readonly operation: 'assign-role' | 'remove-role' }>;
}) {
  const { deps, headers, idempotencyKey, legalEntityId, request } = input;
  const snapshot = yield* deps.directory.snapshot;
  const agent = snapshot.agents.find((candidate) => candidate.principalId === request.principalId);
  if (agent === undefined || agent.status === 'archived') {
    return yield* new ConnectionsNotFound({ reason: AGENT_NOT_FOUND });
  }
  const people = yield* AccessPeopleBff;
  const agentPrincipalId = AgentIdSchema.make(agent.principalId);
  const write =
    request.operation === ASSIGN_ROLE
      ? people.assignAgentRole({
          headers,
          idempotencyKey,
          payload: {
            agentPrincipalId,
            expectedRevision: request.expectedRevision,
            expectedRoleRevisionId: request.expectedRoleRevisionId,
            legalEntityId,
            roleId: request.roleId,
          },
        })
      : people.revokeAgentAssignment({
          headers,
          idempotencyKey,
          payload: {
            agentPrincipalId,
            expectedRevision: request.expectedRevision,
            incarnationId: request.assignmentId,
          },
        });
  yield* write.pipe(Effect.mapError(fromPeopleProblem));
  const changed: ManageAgentEntityResponse = {
    grantsGranted: request.operation === ASSIGN_ROLE ? 1 : 0,
    grantsRevoked: request.operation === 'remove-role' ? 1 : 0,
    operation: request.operation,
    principalId: AgentPrincipalIdSchema.make(agent.principalId),
    revokedConnections: 0,
    status: agent.status === 'active' ? 'active' : 'disabled',
  };
  return changed;
});

// This transport is Core's persisted Action request identity, not an ambient log/span identifier.
const changeAgent = Effect.fn('AgentEntities.changeAgent')(function* applyAgentChange<R>(
  caller: DemoAccountCaller,
  request: ManageAgentEntityRequest,
  deps: ConnectionsAdminDeps<R>,
  headers: Headers,
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

  if (request.operation === 'create') {
    const snapshot = yield* deps.directory.snapshot;
    const agents = snapshot.agents.filter((agent) => agent.status !== 'archived');
    const memberIds = snapshot.people.map((person) => person.principalId);
    // Same idempotency key = same principal id: a retry replays the Core Action instead of failing the name check.
    const principalId = derivedUuid(`${tenantId}:${legalEntityId}:${transport.idempotencyKey}:agent`);
    const problem = agentDraftProblem({
      displayName: request.displayName,
      existingNames: agents.flatMap((agent) => (agent.principalId === principalId ? [] : [agent.displayName])),
      memberIds,
      operatorPrincipalIds: request.operatorPrincipalIds,
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
          // Rights come only from roles: the profile names no modules.
          modules: [],
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
    yield* reconcileTenantProjection(caller.principal);
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
      principalId: AgentPrincipalIdSchema.make(result.principalId),
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
      return yield* new ConnectionsNotFound({ reason: AGENT_NOT_FOUND });
    }
    const problem = agentDraftProblem({
      displayName: request.displayName,
      existingNames: agents.flatMap((other) => (other.principalId === agent.principalId ? [] : [other.displayName])),
      memberIds,
      operatorPrincipalIds: [],
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
          modules: [],
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
    yield* reconcileTenantProjection(caller.principal);
    const configured: ManageAgentEntityResponse = {
      grantsGranted: 0,
      grantsRevoked: 0,
      operation: 'configure',
      principalId: AgentPrincipalIdSchema.make(agent.principalId),
      revokedConnections: 0,
      status: result.status === 'active' ? 'active' : 'disabled',
    };
    return configured;
  }

  if (request.operation === ASSIGN_ROLE || request.operation === 'remove-role') {
    return yield* changeAgentRole({ deps, headers, idempotencyKey: transport.idempotencyKey, legalEntityId, request });
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
  headers: Headers,
  deps: ConnectionsAdminDeps<R>,
) {
  yield* AgentActionRequestIdentity;
  yield* AgentReadRequestIdentity;
  const { legalEntityId, tenantId } = caller.principal;
  yield* requireAgentAdministrator(caller).pipe(
    Effect.tapError((error) =>
      Predicate.isTagged(error, 'ConnectionsForbidden')
        ? auditForbiddenAttempt(
            caller,
            `${request.operation}-agent`,
            'agent',
            request.operation === 'create' ? null : request.principalId,
          ).pipe(Effect.mapError(fromDemoAccountError))
        : Effect.void,
    ),
  );
  return yield* withCompanyAgentLock(tenantId, legalEntityId, changeAgent(caller, request, deps, headers));
}, Effect.scoped);
