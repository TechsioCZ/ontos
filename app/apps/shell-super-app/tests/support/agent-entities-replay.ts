import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  AgentLifecycleAuthorityLive,
  AgentProposalCommandAuthorizationPreflightLive,
  AgentProposalCommandPreparationLive,
  AgentProposalQueueModuleReview,
  ContextAccessLive,
  IdentityAdministrationDeniedAudit,
  IdentityAdministrationDeniedAuditLive,
  makeActionRuntimeLive,
  makeActiveApplicationCompositionService,
  makeDatabaseIdentityEnrollmentLive,
  ReadHandlerUnavailable,
  ReadRuntime,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ActionAuthorityLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import { AccessProjectionWriter } from '@app/core-runtime/access/intent/projection-writer';
import { projectionWriteRefusal } from '../../../../packages/core-runtime/src/access/intent/projection-write-error.ts';
import { CoreDatabase, makeCoreDatabase } from '@app/core-runtime/db/client';
import { agentProposals } from '../../../../packages/core-runtime/src/db/schema.ts';
import { InstalledModuleCatalogServiceLive } from '@app/core-runtime/modules/active-application-composition';
import { AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { AgentAccessClientIdSchema, ConnectionSummarySchema } from '@app/shared-contracts/agent-access';
import type { ManageAgentEntityRequest } from '@app/shared-contracts/agent-access';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { asc, eq } from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';
import { expect } from 'effect-rstest';

import { IdentityAdministrationDeniedAuditUnavailable } from '../../../../packages/core-runtime/src/auth/identity-administration-audit-unavailable.ts';
import { proposalRow } from '../../../../packages/core-runtime/tests/support/agent-proposal-command-fixture.ts';
import { StaffAuthenticationNamespaceRegistryLive } from '../../api/auth/authentication-namespace-registry.ts';
import { AgentActionRequestIdentity } from '../../api/auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../../api/auth/agent-request-identity.ts';
import { SupportImpersonationCorrelationId } from '../../api/auth/support-impersonation-correlation-id.ts';
import { manageAgentEntity } from '../../api/auth/agent-entities.ts';
import { AuthConfig } from '../../api/auth/config.ts';
import type { DemoAccountCaller } from '../../api/auth/demo-accounts.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';
import { ConnectionsUnavailable } from '../../api/oauth-connections-admin/connections-unavailable.ts';
import type { ConnectionsAdminDeps } from '../../api/oauth-connections-admin/ports.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { unusedAccessPeopleBff, AccessPeopleBff } from './access-people-bff-double.ts';
import { buildAccessGraph } from './access-admin-real-gate-fixture.ts';
import type { AccessAdminCase } from './access-admin-real-gate-fixture.ts';
import { installedReleaseComposition } from './installed-release-composition.ts';

export const transport = { correlationId: 'agent-replay-correlation', idempotencyKey: 'agent-replay-original-key' };
export const readTransport = { correlationId: transport.correlationId };
export const firstBatchId = '50000000-0000-4000-8000-000000000001';

interface CleanupState {
  connections: string[];
  events: string[];
  failStep: string | null;
}

interface ReplayOptions {
  readonly actionPermission?: 'allowed' | 'denied';
  readonly batchCount?: number;
  readonly claimedSibling?: boolean;
  readonly exists?: boolean;
  readonly member?: boolean;
}

/** One owned PostgreSQL case. Only the explicit cleanup ports and faulting service calls are controlled. */
export const makeAgentReplay = Effect.fn('AgentReplay.make')(function* buildReplay(
  accessCase: AccessAdminCase,
  options: ReplayOptions = {},
) {
  const [company] = accessCase.companies;
  if (company === undefined) {
    return yield* Effect.die('The case must seed a company');
  }
  const persona = options.actionPermission === 'denied' ? 'member' : 'companyAdmin';
  if (options.actionPermission === 'denied') {
    // Admit the Shell page but not the native status Action. Both answers still come from the real gate.
    yield* accessCase.grantRole({
      capabilityKeys: ['shell-super-app.access-admin.agents'],
      legalEntityId: company,
      persona,
    });
  }
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
    yield* accessCase.scopeFor(persona, company),
  );
  const caller: DemoAccountCaller = { legalName: 'P14 company', principal: { ...principal, legalEntityId: company } };
  const agent = accessCase.ids.get('agent');
  if (agent === undefined) {
    return yield* Effect.die('The case must seed an agent');
  }
  const agentId = AgentPrincipalIdSchema.make(
    options.exists === false ? '00000000-0000-4000-8000-999999999999' : agent.principalId,
  );
  if (options.member !== false && options.exists !== false) {
    yield* accessCase.admin.unsafe(
      `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, affiliation, status)
         values ($1, $2, $3, null, 'active')`,
      [accessCase.tenantId, company, agentId],
    );
  }
  const composition = yield* installedReleaseComposition;
  const database = yield* makeCoreDatabase({ ...accessCase.databases.runtime, maxConnections: 6 });
  const adminDatabase = yield* makeCoreDatabase(accessCase.databases.admin);
  const rows = Array.from({ length: options.batchCount ?? 1 }, (_value, index) =>
    proposalRow({
      agentPrincipalId: agentId,
      batchId: `50000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      legalEntityId: company,
      proposalId: `60000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      tenantId: accessCase.tenantId,
    }),
  );
  const [first] = rows;
  if (options.claimedSibling === true && first !== undefined) {
    rows.push({
      ...first,
      decidedAt: new Date('2026-10-25T12:00:00.000Z'),
      decidedByPrincipalId: principal.principalId,
      position: 1,
      proposalId: '60000000-0000-4000-8000-999999999999',
    });
  }
  yield* adminDatabase.executor.insert(agentProposals).values(rows);
  const cleanup: CleanupState = {
    connections: ['connection-1', 'connection-2'],
    events: [],
    failStep: null,
  };
  const observe = (name: string) =>
    Effect.sync(() => {
      cleanup.events.push(name);
      if (cleanup.failStep !== name) {
        return false;
      }
      cleanup.failStep = null;
      return true;
    });
  const step = (name: string) =>
    observe(name).pipe(
      Effect.flatMap((fail) =>
        fail ? Effect.fail(new ConnectionsUnavailable({ cause: `Interrupted ${name}` })) : Effect.void,
      ),
    );
  const active = Layer.succeed(
    ActiveApplicationCompositionService,
    makeActiveApplicationCompositionService(Effect.succeed(composition)),
  );
  const base = Layer.mergeAll(
    Layer.succeed(CoreDatabase, database),
    makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT),
    active,
    NodeCrypto.layer,
    NodeServices.layer,
  );
  const ports = AccessEnforcementPortsLive.pipe(Layer.provide(TenantIntentLoaderLive), Layer.provideMerge(base));
  const gate = AccessDecisionLive.pipe(Layer.provideMerge(ports));
  const authority = ActionAuthorityLive.pipe(Layer.provideMerge(gate));
  const contextAccess = Layer.mergeAll(ContextAccessLive, StaffAuthenticationNamespaceRegistryLive);
  const states = TenantModuleStateServiceLive.pipe(Layer.provide(base));
  const stateGate = ModuleStateGateLive.pipe(Layer.provide(states));
  const entrypoints = ModuleEntrypointGatewayLive.pipe(Layer.provide(stateGate));
  const resolver = OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(contextAccess, authority)));
  const shared = Layer.mergeAll(contextAccess, states, stateGate, entrypoints, resolver);
  const preparation = AgentProposalCommandPreparationLive.pipe(
    Layer.provide(AgentLifecycleAuthorityLive),
    Layer.provide(Layer.mergeAll(shared, authority)),
  );
  const actionsLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
    Layer.provide(
      Layer.mergeAll(
        shared,
        InstalledModuleCatalogServiceLive.pipe(Layer.provide(active)),
        ActionRepositoryLive.pipe(Layer.provide(base)),
        ActionPermissionLive,
        AgentProposalCommandAuthorizationPreflightLive.pipe(Layer.provide(preparation)),
      ).pipe(Layer.provideMerge(authority)),
    ),
  );
  const readsLive = ReadRuntimeLive.pipe(Layer.provide(Layer.mergeAll(shared, authority)));
  const auditLive = IdentityAdministrationDeniedAuditLive.pipe(Layer.provide(Layer.mergeAll(shared, authority)));
  const services = yield* Layer.build(
    Layer.mergeAll(
      actionsLive,
      readsLive,
      auditLive,
      shared,
      preparation,
      authority,
      Layer.succeed(AgentProposalQueueModuleReview, {
        review: () => Effect.die('Lifecycle withdrawal must not read private business data'),
      }),
    ),
  );
  const runtime = Context.get(services, ActionRuntime);
  const readRuntime = Context.get(services, ReadRuntime);
  const realAudit = Context.get(services, IdentityAdministrationDeniedAudit);
  const realGate = Context.get(services, AccessDecisionGate);
  const graph = yield* buildAccessGraph({
    adminUrl: accessCase.databases.runtime.connectionString,
    configuration: yield* loadSpiceDbConfig(),
  });
  const actions: { readonly payload: unknown; readonly principal: unknown; readonly transport: unknown }[] = [];
  const proposalActions: typeof actions = [];
  const readInputs: { readonly input: unknown; readonly principal: unknown; readonly transport: unknown }[] = [];
  const snapshot = Effect.gen(function* snapshot() {
    const [target] = yield* accessCase.admin.unsafe<{ readonly status: string }>(
      'select status from core.principals where tenant_id = $1 and principal_id = $2',
      [accessCase.tenantId, agent.principalId],
    );
    const proposals = yield* adminDatabase.executor
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.tenantId, accessCase.tenantId))
      .orderBy(asc(agentProposals.batchId), asc(agentProposals.position));
    const committed = yield* accessCase.admin.unsafe<{
      readonly actionKey: string;
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly principalId: string;
      readonly requestHash: string;
    }>(
      `select action_key as "actionKey", idempotency_key as "idempotencyKey", request_hash as "requestHash",
                principal_id as "principalId", correlation_id as "correlationId"
           from core.action_invocations where tenant_id = $1 and status = 'succeeded'
          order by started_at, action_key`,
      [accessCase.tenantId],
    );
    const statusWrites = yield* accessCase.admin.unsafe(
      `select audit_event_id from core.audit_events where tenant_id = $1
          and evidence_json ->> 'targetPrincipalId' = $2 and evidence_json ->> 'previousStatus' is not null`,
      [accessCase.tenantId, agentId],
    );
    const readEvidence = yield* accessCase.admin.unsafe(
      `select data_access_event_id from core.data_access_events where tenant_id = $1
          and evidence_policy_key = 'core.identity.agent-proposal-queue.access.v1'`,
      [accessCase.tenantId],
    );
    return {
      committed,
      proposals: proposals.filter((row) => row.status === 'pending' && row.decidedAt === null).length,
      readEvidence: readEvidence.length,
      rows: proposals,
      status: target?.status,
      statusWrites: statusWrites.length,
    };
  });
  const connection = (grantId: string) =>
    Schema.decodeUnknownSync(ConnectionSummarySchema)({
      acting: { displayName: 'Agent', kind: 'agent', principalId: agentId },
      allModules: true,
      client: {
        clientId: AgentAccessClientIdSchema.make('test-client'),
        host: 'example.invalid',
        kind: 'cimd',
        logoUri: null,
        name: 'Test client',
      },
      createdAt: '2026-10-25T00:00:00.000Z',
      delegatedBy: { displayName: 'Administrator', principalId: principal.principalId },
      granted: { modules: [], writePolicy: 'read_only' },
      grantId,
      lastUsedAt: null,
      legalEntityId: company,
      legalName: 'P14 company',
      limits: { maxWritePolicy: 'read_only', modules: [] },
      live: true,
      modules: [],
      profileId: 'test-profile',
      revokedAt: null,
      revokeNote: null,
      revokeReason: null,
      status: 'active',
      tenantId: accessCase.tenantId,
      user: { displayName: 'Administrator', principalId: principal.principalId },
      writePolicy: 'read_only',
    });
  const deps: ConnectionsAdminDeps<never> = {
    directory: {
      confirmArchived: (id) =>
        Effect.gen(function* confirmArchived() {
          expect(id).toBe(agentId);
          expect((yield* snapshot.pipe(Effect.orDie)).status).toBe('archived');
          yield* step('confirm-archived');
        }),
      replaceOperators: () => Effect.die('Unexpected operator command'),
      snapshot: Effect.sync(() => {
        cleanup.events.push('snapshot');
        return { agents: [], members: [], people: [] };
      }),
    },
    grants: {
      get: () => Effect.die('Unexpected connection lookup'),
      list: (filter) =>
        Effect.gen(function* list() {
          expect(filter).toEqual({
            actingPrincipalId: agentId,
            legalEntityId: company,
            statuses: ['active'],
            tenantId: accessCase.tenantId,
          });
          yield* step('connections');
          return cleanup.connections.map(connection);
        }),
      revoke: (input) =>
        step(input.grantId).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(input.actorPrincipalId).toBe(principal.principalId);
              expect(input.reasonCode).toBe('admin');
              cleanup.connections.splice(cleanup.connections.indexOf(input.grantId), 1);
            }),
          ),
        ),
      update: () => Effect.die('Unexpected connection update'),
    },
    mcpUrl: 'https://example.invalid/mcp',
  };
  const reconcileTenant: (typeof AccessProjectionWriter)['Service']['reconcileTenant'] = Effect.fn(
    'AgentReplay.reconcileTenant',
  )(function* reconcileTenant(input) {
    // This is the production company lock's exact 64-bit key, held by its private PostgreSQL session.
    const locks = yield* accessCase.admin
      .unsafe(
        `select pid from pg_locks where locktype = 'advisory' and granted and objsubid = 1
          and database = (select oid from pg_database where datname = current_database())
          and classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
          and objid = (hashtextextended($1, 0) & 4294967295)::oid`,
        [`agent-entities:${accessCase.tenantId}:${company}`],
      )
      .pipe(Effect.orDie);
    expect(locks).toHaveLength(1);
    if (yield* observe('projection')) {
      return yield* projectionWriteRefusal('access_projection_write_unavailable', 'Injected projection failure');
    }
    return yield* graph.writer.reconcileTenant(input);
  });
  const run = (request: ManageAgentEntityRequest) =>
    manageAgentEntity(caller, request, new Headers(), deps).pipe(
      Effect.provideService(AccessPeopleBff, unusedAccessPeopleBff),
      Effect.provideService(AgentActionRequestIdentity, transport),
      Effect.provideService(AgentReadRequestIdentity, readTransport),
      Effect.provideService(SupportImpersonationCorrelationId, transport.correlationId),
      Effect.provideService(AuthConfig, {
        baseUrl: 'https://example.invalid',
        connectionString: accessCase.databases.runtime.connectionString,
        secret: 'integration-only',
        secureCookies: false,
        supportUserIds: [],
        trustedOrigins: [],
      }),
      Effect.provideService(AccessDecisionGate, {
        ...realGate,
        decide: (input) =>
          Effect.gen(function* decide() {
            if (input.carrier.accessDeclaration?.key === 'shell-super-app.access-admin.agents') {
              cleanup.events.push('administrator');
            }
            return yield* realGate.decide(input);
          }),
      }),
      Effect.provideService(IdentityAdministrationDeniedAudit, {
        record: (input) =>
          observe('denied-audit').pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(
                    new IdentityAdministrationDeniedAuditUnavailable({
                      cause: 'Injected denied audit failure',
                      reason: 'Injected denied audit failure',
                    }),
                  )
                : realAudit.record(input),
            ),
          ),
      }),
      Effect.provideService(AccessProjectionWriter, { reconcileTenant }),
      Effect.provideService(ActionRuntime, {
        ...runtime,
        runAction: (input) => {
          const proposal = input.registration.descriptor.actionKey === 'core.identity.mutate-agent-proposals';
          cleanup.events.push(proposal ? 'withdraw-action' : 'action');
          (proposal ? proposalActions : actions).push(input);
          return runtime.runAction(input);
        },
      }),
      Effect.provideService(ReadRuntime, {
        ...readRuntime,
        runRead: (input) =>
          Effect.gen(function* runRead() {
            readInputs.push({ input: input.input, principal: input.principal, transport: input.transport });
            if (
              Schema.is(Schema.Struct({ mode: Schema.Literal('withdrawal-batches') }))(input.input) &&
              (yield* observe('proposals'))
            ) {
              return yield* new ReadHandlerUnavailable({
                code: 'read_handler_unavailable',
                reason: 'Injected withdrawal read failure',
              });
            }
            return yield* readRuntime.runRead(input);
          }),
      }),
      Effect.provideContext(services),
    );
  const denyAdministration = Effect.gen(function* denyAdministration() {
    yield* accessCase.admin.unsafe(
      "update core.access_memberships set status = 'revoked' where tenant_id = $1 and principal_id = $2 and kind = 'access_admin'",
      [accessCase.tenantId, principal.principalId],
    );
    yield* accessCase.admin.unsafe(
      "update core.access_assignments set status = 'revoked' where tenant_id = $1 and principal_id = $2",
      [accessCase.tenantId, principal.principalId],
    );
    yield* graph.writer.reconcileTenant({ scope: yield* accessCase.scopeFor('owner', company) });
  });
  const setStatus = (status: 'active' | 'disabled') =>
    accessCase.admin.unsafe('update core.principals set status = $3 where tenant_id = $1 and principal_id = $2', [
      accessCase.tenantId,
      agentId,
      status,
    ]);
  return {
    actions,
    agentId,
    cleanup,
    denyAdministration,
    principal: caller.principal,
    proposalActions,
    readInputs,
    run,
    setStatus,
    snapshot,
  };
}, Effect.provide(NodeCrypto.layer));
