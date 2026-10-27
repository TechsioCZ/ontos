import { Effect, Layer, Schema } from 'effect' with { rstest: 'importActual' };
import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  ContextAccess,
  manageAgentStatusAction,
  mutateAgentProposalsAction,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService, withPostgresSessionAdvisoryLock } from '@app/core-runtime';
import { ActionAuthorizationLifecycle } from '@app/core-runtime/outbox/core-system-worker';
import { ManageAgentEntityRequestSchema } from '@app/shared-contracts/agent-access';
import type { ConnectionSummary, ManageAgentEntityRequest } from '@app/shared-contracts/agent-access';
import { NodeCrypto } from '@effect/platform-node';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { beforeEach, expect, it, rs } from 'effect-rstest';

import {
  bindActionTestServices,
  makeActionTestHarness,
} from '../../../../packages/core-runtime/src/testing/actions.ts';
import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import { makeReadTestHarness } from '../../../../packages/core-runtime/src/testing/reads.ts';
import {
  AgentProposalCommandAuthorizationPreflightLive,
  AgentProposalCommandPreparation,
  AgentProposalCommandPreparationLive,
} from '../../../../packages/core-runtime/src/auth/agent-proposal-command-preparation.ts';
import { proposalCommandsFromTransaction } from '../../../../packages/core-runtime/src/auth/agent-proposal-command-persistence.ts';
import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../../../packages/core-runtime/src/db/database-identity-manifest.ts';
import { DatabaseIdentityEnrollmentContext } from '../../../../packages/core-runtime/src/db/database-identities.ts';
import { ActionAuthority } from '../../../../packages/core-runtime/src/permissions/action-authority.ts';
import { ActionAuthorizationPreflight } from '../../../../packages/core-runtime/src/permissions/action-authorization-preflight.ts';
import {
  operationTime,
  proposalRow,
  proposalSqlRow,
} from '../../../../packages/core-runtime/tests/support/agent-proposal-command-fixture.ts';
import type { Proposal } from '../../../../packages/core-runtime/tests/support/agent-proposal-command-fixture.ts';
import { installOperationalScopeAt } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { ActionAuthorizationLifecycleError } from '../../../../packages/core-runtime/src/permissions/action-authorization-lifecycle-error.ts';
import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { AgentActionRequestIdentity } from '../../api/auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../../api/auth/agent-request-identity.ts';
import { proposalSubcommandKey } from '../../api/agent-platform/proposal-store.ts';
import { manageAgentEntity } from '../../api/auth/agent-entities.ts';
import { AuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { DemoAccountForbidden } from '../../api/auth/demo-accounts.ts' with { rstest: 'importActual' };
import type { DemoAccountCaller } from '../../api/auth/demo-accounts.ts';
import { DemoAccountUnavailable } from '../../api/auth/demo-account-unavailable.ts';
import { makeInstalledModuleCatalogLayer } from '../../api/modules/installed-module-catalog.ts';
import { ConnectionsUnavailable } from '../../api/oauth-connections-admin/connections-unavailable.ts';
import { ConnectionsForbidden } from '../../api/oauth-connections-admin/connections-forbidden.ts';
import { ConnectionsGone } from '../../api/oauth-connections-admin/connections-gone.ts';
import { ConnectionsInvalid } from '../../api/oauth-connections-admin/connections-invalid.ts';
import type { ConnectionsAdminDeps } from '../../api/oauth-connections-admin/ports.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
import { nativeDemoAccountTestServices } from '../support/native-demo-account-services.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

interface CleanupState {
  administrator: boolean;
  connections: string[];
  events: string[];
  failStep: string | null;
  grants: number;
  proposals: number;
}
const external = rs.hoisted(() => {
  const state: CleanupState = {
    administrator: true,
    connections: ['connection-1', 'connection-2'],
    events: [],
    failStep: null,
    grants: 2,
    proposals: 1,
  };
  return state;
});
const lifecycleFailure = () => new ActionAuthorizationLifecycleError({ reason: 'Interrupted projection' });
const step = (name: string) =>
  Effect.suspend(() => {
    external.events.push(name);
    if (external.failStep === name) {
      external.failStep = null;
      return Effect.fail(new ConnectionsUnavailable({ cause: `Interrupted ${name}` }));
    }
    return Effect.void;
  });
rs.mock('../../../../packages/core-runtime/src/install/demo-account-administration.ts', () => ({
  get openDemoAccountGrants() {
    return Effect.succeed({
      replaceAgentGrants: () =>
        step('grants').pipe(
          Effect.map(() => {
            const revoked = external.grants;
            external.grants = 0;
            return { granted: 0, revoked };
          }),
        ),
      rolePolicyOf: () => Effect.succeed([]),
    });
  },
}));
rs.mock('../../../../packages/core-runtime/src/db/session-advisory-lock.ts', () => ({
  withPostgresSessionAdvisoryLock: <A, E, R>(
    _connection: Parameters<typeof withPostgresSessionAdvisoryLock>[0],
    _key: string,
    effect: Effect.Effect<A, E, R>,
  ) => effect,
}));
rs.mock('../../api/auth/demo-accounts.ts', () => ({
  auditForbiddenAttempt: () =>
    step('denied-audit').pipe(Effect.mapError((cause) => new DemoAccountUnavailable({ cause }))),
  requireAdministrator: () =>
    Effect.suspend(() => {
      external.events.push('administrator');
      return external.administrator ? Effect.void : Effect.fail(new DemoAccountForbidden({ reason: 'Denied' }));
    }),
}));
beforeEach(() => {
  external.administrator = true;
  external.connections = ['connection-1', 'connection-2'];
  external.events = [];
  external.failStep = null;
  external.grants = 2;
  external.proposals = 1;
});

const principal: DemoAccountCaller['principal'] = {
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:agent-replay-test',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const caller: DemoAccountCaller = { legalName: 'Company', principal };
const agentId = '00000000-0000-4000-8000-000000000004';
const firstBatchId = '50000000-0000-4000-8000-000000000001';
const transport = { correlationId: 'agent-replay-correlation', idempotencyKey: 'agent-replay-original-key' };
const readTransport = { correlationId: transport.correlationId };
const disable: ManageAgentEntityRequest = {
  expectedStatus: 'active',
  newStatus: 'disabled',
  operation: 'change-status',
  principalId: agentId,
  reason: 'Ukončení provozu',
};
const archive: ManageAgentEntityRequest = {
  expectedStatus: 'active',
  operation: 'delete',
  principalId: agentId,
  reason: 'Ukončení provozu',
};
const StatusSchema = Schema.Literals(['active', 'disabled', 'archived']);
const connection = (grantId: string): ConnectionSummary => ({
  acting: { displayName: 'Agent', kind: 'agent', principalId: agentId },
  allModules: true,
  client: { clientId: 'test-client', host: 'example.invalid', kind: 'cimd', logoUri: null, name: 'Test client' },
  createdAt: '2026-10-25T00:00:00.000Z',
  delegatedBy: { displayName: 'Administrator', principalId: principal.principalId },
  granted: { modules: [], writePolicy: 'read_only' },
  grantId,
  lastUsedAt: null,
  legalEntityId: principal.legalEntityId,
  legalName: 'Company',
  limits: { maxWritePolicy: 'read_only', modules: [] },
  modules: [],
  profileId: 'test-profile',
  revokedAt: null,
  revokeNote: null,
  revokeReason: null,
  status: 'active',
  tenantId: principal.tenantId,
  user: { displayName: 'Administrator', principalId: principal.principalId },
  writePolicy: 'read_only',
});

interface AgentState {
  rows: Proposal[];
  status: typeof StatusSchema.Type;
}
interface ReplayOptions {
  readonly actionPermission?: 'allowed' | 'denied';
  readonly batchCount?: number;
  readonly claimedSibling?: boolean;
  readonly exists?: boolean;
  readonly member?: boolean;
}
const unclaimed = (row: Proposal) => row.status === 'pending' && row.decidedAt === null;
const proposalOwnerRows = (state: AgentState, sql: string, params: readonly unknown[]) => {
  expect(params).toContain(principal.legalEntityId);
  if (sql.startsWith('select')) {
    const rows = state.rows.filter((row) => params.includes(row.batchId));
    expect(rows.length).toBeGreaterThan(0);
    return rows.map(proposalSqlRow);
  }
  expect(sql.startsWith('update')).toBe(true);
  expect(params).toContain(agentId);
  expect(params).toContain('rejected');
  expect(params).toContain(principal.principalId);
  const affected = state.rows.filter(
    (row) => params.includes(row.batchId) && params.includes(row.proposalId) && unclaimed(row),
  );
  state.rows = state.rows.map((row) =>
    affected.includes(row)
      ? { ...row, decidedAt: operationTime, decidedByPrincipalId: principal.principalId, status: 'rejected' }
      : row,
  );
  external.proposals = state.rows.filter(unclaimed).length;
  return affected.map(({ proposalId }) => ({ proposalId }));
};
const principalOwnerRows = (state: AgentState, options: ReplayOptions, sql: string, params: readonly unknown[]) => {
  if (sql.startsWith('select') && sql.includes('left join')) {
    const isAgent = params.includes(agentId);
    return [
      {
        displayName: isAgent ? 'Agent' : 'Administrator',
        kind: isAgent ? 'agent' : 'human',
        principalId: isAgent ? agentId : principal.principalId,
        status: isAgent ? state.status : 'active',
      },
    ];
  }
  if (sql.startsWith('select') && sql.includes('"principal_company_memberships"')) {
    external.events.push('owner-membership');
    expect(params).toContain(principal.legalEntityId);
    expect(sql).toContain('for update');
    return options.member === false ? [] : [{ affiliation: null, status: 'active' }];
  }
  if (sql.startsWith('update')) {
    external.events.push('owner-update');
    expect(params).toContain(agentId);
    state.status = Schema.decodeUnknownSync(StatusSchema)(params.find((value) => Schema.is(StatusSchema)(value)));
    return [];
  }
  if (sql.includes('clock_timestamp')) {
    return [{ now: operationTime }];
  }
  if (sql.includes('pg_advisory_xact_lock')) {
    return [{ lock: null }];
  }
  if (sql.startsWith('select "status"')) {
    expect(params).toContain(agentId);
    return [{ status: state.status }];
  }
  if (sql.startsWith('select "principal_id"')) {
    return [{ principalId: params.includes(agentId) ? agentId : principal.principalId }];
  }
  external.events.push('owner-target');
  expect(params).toContain(agentId);
  expect(sql).toContain('for update');
  return options.exists === false ? [] : [{ displayName: 'Agent', kind: 'agent', status: state.status }];
};
const scriptOwner = (state: AgentState, options: ReplayOptions) => (sql: string, params: readonly unknown[]) =>
  Effect.gen(function* ownerQuery() {
    if (/^(?:begin|commit|rollback|savepoint|release savepoint)(?:\s|$)/iu.test(sql.trim())) {
      return [];
    }
    if (sql.includes('set_config')) {
      expect(params).toEqual([principal.tenantId, principal.legalEntityId]);
      return [
        {
          legal_entity_id: principal.legalEntityId,
          operation_at: operationTime,
          role: SHARED_RUNTIME_IDENTITY.role,
          tenant_id: principal.tenantId,
        },
      ];
    }
    if (sql.includes('current_setting')) {
      return [
        { legal_entity_id: principal.legalEntityId, role: SHARED_RUNTIME_IDENTITY.role, tenant_id: principal.tenantId },
      ];
    }
    expect(params).toContain(principal.tenantId);
    if (sql.includes('"agent_proposals"') && sql.includes('group by')) {
      yield* step('proposals').pipe(
        Effect.mapError((cause) => new SqlError({ reason: new ConnectionError({ cause }) })),
      );
      expect(params).toContain(principal.legalEntityId);
      expect(params).toContain(agentId);
      expect(sql).toContain('"decided_at" is null');
      expect(params).toContain(32);
      const after = state.rows.find((row) => params.includes(row.batchId))?.batchId;
      return [
        ...new Set(
          state.rows
            .filter((row) => unclaimed(row) && (after === undefined || row.batchId > after))
            .map((row) => row.batchId),
        ),
      ]
        .toSorted()
        .slice(0, 32)
        .map((batchId) => ({ batchId }));
    }
    if (sql.includes('"action_invocations"') || sql.includes('"audit_events"')) {
      expect(params).toContain(principal.legalEntityId);
      return [];
    }
    if (sql.includes('"agent_proposals"')) {
      return proposalOwnerRows(state, sql, params);
    }
    if (sql.includes('"principals"') || sql.includes('"principal_company_memberships"')) {
      return principalOwnerRows(state, options, sql, params);
    }
    throw new Error(`Unexpected owner SQL: ${sql}`);
  });
const removeConnection = (grantId: string) =>
  Effect.sync(() => {
    external.connections = external.connections.filter((id) => id !== grantId);
  });

// Real native runtime, request hashing, registration and private status handler. Only the owner SQL driver,
// authority graph and Shell cleanup IO are scripted: these tests do not establish live DB/RLS guarantees.
const fixture = (options: ReplayOptions = {}) =>
  Effect.gen(function* replayFixture() {
    const rows = Array.from({ length: options.batchCount ?? 1 }, (_value, index) =>
      proposalRow({
        agentPrincipalId: agentId,
        batchId: `50000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
        legalEntityId: principal.legalEntityId,
        proposalId: `60000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
        tenantId: principal.tenantId,
      }),
    );
    const [first] = rows;
    if (options.claimedSibling === true && first !== undefined) {
      rows.push({
        ...first,
        decidedAt: operationTime,
        decidedByPrincipalId: principal.principalId,
        position: 1,
        proposalId: '60000000-0000-4000-8000-999999999999',
      });
    }
    const state: AgentState = { rows, status: 'active' };
    external.proposals = rows.filter(unclaimed).length;
    const owner = yield* makeWithDefaults({ relations: coreRelations }).pipe(
      Effect.provide(
        scriptedPgClientLayer(Effect.succeed(testSqlConnection(scriptOwner(state, options)))).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      ),
    );
    const { scoped } = yield* installOperationalScopeAt(
      owner,
      { ...principal, correlationId: transport.correlationId },
      FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    );
    const composition = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'notes', moduleId: 'fixture.notes' }),
    ]);
    const preparation = yield* AgentProposalCommandPreparation.pipe(
      Effect.provide(AgentProposalCommandPreparationLive),
      Effect.provideService(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      Effect.provideService(CoreDatabase, { executor: owner }),
      Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(composition) }),
      Effect.provideService(ContextAccess, makeContextAccessDouble('allowed')),
      Effect.provideService(ActionAuthority, {
        checkActionAuthorities: () => Effect.die('Lifecycle withdrawal does not confer business execution'),
        checkActionProposalPermission: () => Effect.die('Unexpected proposal authority'),
      }),
    );
    // Both hooks close over this exact live instance; a second preparation has no invocation snapshot to consume.
    const preflight = yield* ActionAuthorizationPreflight.pipe(
      Effect.provide(AgentProposalCommandAuthorizationPreflightLive),
      Effect.provideService(AgentProposalCommandPreparation, preparation),
    );
    const harness = yield* makeActionTestHarness({
      actionPermission: options.actionPermission ?? 'allowed',
      compositionRevision: composition.composition.revision,
      databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      services: [
        bindActionTestServices(manageAgentStatusAction, { transaction: scoped }),
        bindActionTestServices(mutateAgentProposalsAction, {
          ...proposalCommandsFromTransaction(scoped),
          consumePreparation: preparation.consume,
        }),
      ],
    }).pipe(Effect.provideService(ActionAuthorizationPreflight, preflight));
    const reads = yield* makeReadTestHarness({
      compositionRevision: composition.composition.revision,
      databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executeOwnerQuery: ({ params, sql }) => scriptOwner(state, options)(sql, params),
      operationTime,
      ownerAuthorizationDecision: 'allowed',
      permissionDecision: 'allowed',
      scope: { ...principal, correlationId: transport.correlationId },
    }).pipe(Effect.provide(NodeCrypto.layer));
    const actions: { readonly payload: unknown; readonly principal: unknown; readonly transport: unknown }[] = [];
    const proposalActions: typeof actions = [];
    const readInputs: { readonly input: unknown; readonly principal: unknown; readonly transport: unknown }[] = [];
    const runtime: ActionRuntimeService = {
      ...harness.runtime,
      runAction: (input) => {
        const proposal = input.registration.descriptor.actionKey === mutateAgentProposalsAction.descriptor.actionKey;
        external.events.push(proposal ? 'withdraw-action' : 'action');
        (proposal ? proposalActions : actions).push(input);
        return harness.runtime.runAction(input);
      },
    };
    const readRuntime: ReadRuntimeService = {
      ...reads.runtime,
      runRead: (input) => {
        readInputs.push({
          input: input.inputFormat === 'decoded' ? input.decodedInput : input.input,
          principal: input.principal,
          transport: input.transport,
        });
        return reads.runtime.runRead(input);
      },
    };
    const deps: ConnectionsAdminDeps<never> = {
      directory: {
        confirmArchived: (id) => {
          expect(id).toBe(agentId);
          expect(state.status).toBe('archived');
          return step('confirm-archived');
        },
        replaceOperators: () => Effect.die('Unexpected operator command'),
        snapshot: Effect.sync(() => {
          external.events.push('snapshot');
          // An archived principal is deliberately not made visible to recovery.
          return { agents: [], members: [], people: [] };
        }),
      },
      grants: {
        get: () => Effect.die('Unexpected connection lookup'),
        list: (filter) => {
          expect(filter).toEqual({
            actingPrincipalId: agentId,
            legalEntityId: principal.legalEntityId,
            statuses: ['active'],
            tenantId: principal.tenantId,
          });
          return step('connections').pipe(Effect.map(() => external.connections.map(connection)));
        },
        revoke: (input) => {
          expect(input.actorPrincipalId).toBe(principal.principalId);
          expect(input.reasonCode).toBe('admin');
          return step(input.grantId).pipe(Effect.tap(() => removeConnection(input.grantId)));
        },
        update: () => Effect.die('Unexpected connection update'),
      },
      mcpUrl: 'https://example.invalid/mcp',
    };
    const nativeServices = yield* nativeDemoAccountTestServices(caller, transport, makeContextAccessDouble('allowed'));
    const run = (request: ManageAgentEntityRequest) =>
      manageAgentEntity(caller, request, deps).pipe(
        Effect.provideService(ReadRuntime, readRuntime),
        Effect.provideService(AgentProposalCommandPreparation, preparation),
        Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(composition) }),
        Effect.provide(nativeServices),
        Effect.provideService(AgentActionRequestIdentity, transport),
        Effect.provideService(AgentReadRequestIdentity, readTransport),
        Effect.provideService(ActionRuntime, runtime),
        Effect.provideService(ContextAccess, makeContextAccessDouble('allowed')),
        Effect.provideService(AuthDatabase, {
          get adapter(): AuthDatabase['Service']['adapter'] {
            throw new Error('Unexpected authentication adapter IO');
          },
          get executor(): AuthDatabase['Service']['executor'] {
            throw new Error('Unexpected authentication database IO');
          },
        }),
        Effect.provideService(ActionAuthorizationLifecycle, {
          reconcilePrincipal: (tenantId, principalId) => {
            expect(tenantId).toBe(principal.tenantId);
            expect(principalId).toBe(agentId);
            return step('projection').pipe(Effect.mapError(lifecycleFailure));
          },
          reconcileScopedRoleMembership: () => Effect.die('Unexpected role reconciliation'),
          reconcileTenant: () => Effect.die('Unexpected tenant reconciliation'),
        }),
        Effect.provideService(AuthConfig, {
          baseUrl: 'https://example.invalid',
          connectionString: 'postgresql://unused.invalid/test',
          secret: 'unit-test-only',
          secureCookies: false,
          supportUserIds: [],
          trustedOrigins: [],
        }),
        Effect.provide(makeInstalledModuleCatalogLayer(Effect.succeed(composition))),
        Effect.provideService(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      );
    return { actions, harness, proposalActions, readInputs, reads, run, state };
  });

it.effect('resumes a committed status change after projection interruption despite the changed current status', () =>
  Effect.gen(function* committedStatusRetry() {
    const test = yield* fixture();
    external.failStep = 'projection';
    const failure = yield* test.run(disable).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(ConnectionsUnavailable);
    expect(test.state.status).toBe('disabled');
    expect(external.connections).toHaveLength(2);
    external.events = [];
    const result = yield* test.run(disable);
    expect(result.status).toBe('disabled');
    expect(result.revokedConnections).toBe(2);
    expect(external.events).toEqual([
      'administrator',
      'action',
      'projection',
      'connections',
      'connection-1',
      'connection-2',
      'proposals',
      'withdraw-action',
    ]);
    expect(external.proposals).toBe(0);
    expect(test.actions[0]?.principal).toBe(principal);
    expect(test.actions[1]?.principal).toBe(principal);
    expect(test.actions[1]?.transport).toBe(transport);
    expect(test.actions[0]?.payload).toEqual(test.actions[1]?.payload);
    expect(test.harness.snapshot().committed.map(({ actionKey }) => actionKey)).toEqual([
      'core.identity.manage-agent-status',
      'core.identity.mutate-agent-proposals',
    ]);
    expect(test.harness.snapshot().transactionCount).toBe(2);
    for (const read of test.readInputs) {
      expect(read.principal).toBe(principal);
      expect(read.transport).toBe(readTransport);
    }
    expect(test.readInputs.map(({ input }) => input)).toEqual([
      { agentPrincipalId: agentId, mode: 'withdrawal-batches' },
      {
        idempotencyKey: proposalSubcommandKey(transport.idempotencyKey, 'withdraw-pending-of-agent', firstBatchId),
        mode: 'command-recovery',
        payload: {
          batchId: firstBatchId,
          note: `Agent byl deaktivován: ${disable.reason}`,
          operation: 'withdraw-pending-of-agent',
        },
      },
    ]);
    expect(test.proposalActions[0]?.principal).toBe(principal);
    expect(test.proposalActions[0]?.payload).toEqual({
      batchId: firstBatchId,
      note: `Agent byl deaktivován: ${disable.reason}`,
      operation: 'withdraw-pending-of-agent',
    });
    expect(test.proposalActions[0]?.transport).toEqual({
      correlationId: transport.correlationId,
      idempotencyKey: proposalSubcommandKey(transport.idempotencyKey, 'withdraw-pending-of-agent', firstBatchId),
    });
    expect(test.reads.snapshot().evidenceWrites).toBe(2);
  }),
);

it.effect('resumes archive cleanup after the target disappears without reading hidden archived profiles', () =>
  Effect.gen(function* committedArchiveRetry() {
    const test = yield* fixture();
    external.failStep = 'grants';
    expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsUnavailable);
    expect(test.state.status).toBe('archived');
    expect(external.events).toEqual([
      'administrator',
      'action',
      'owner-target',
      'owner-membership',
      'owner-update',
      'projection',
      'connections',
      'connection-1',
      'connection-2',
      'proposals',
      'withdraw-action',
      'grants',
    ]);
    external.events = [];
    const result = yield* test.run(archive);
    expect(result.status).toBe('archived');
    expect(result.revokedConnections).toBe(0);
    expect(result.grantsRevoked).toBe(2);
    expect(external.events).toEqual([
      'administrator',
      'action',
      'projection',
      'connections',
      'proposals',
      'grants',
      'confirm-archived',
    ]);
    expect(test.actions[0]?.payload).toEqual(test.actions[1]?.payload);
    expect(test.harness.snapshot().committed).toHaveLength(2);
    expect(test.proposalActions).toHaveLength(1);
    expect(external.grants).toBe(0);
  }),
);

for (const request of [disable, archive]) {
  it.effect(`rejects a changed ${request.operation} payload under the committed original key before cleanup`, () =>
    Effect.gen(function* changedPayload() {
      const test = yield* fixture();
      external.failStep = 'projection';
      yield* test.run(request).pipe(Effect.flip);
      external.events = [];
      const changed: ManageAgentEntityRequest =
        request.operation === 'change-status'
          ? { ...request, expectedStatus: 'disabled', newStatus: 'active' }
          : { ...request, expectedStatus: 'disabled' };
      expect(yield* test.run(changed).pipe(Effect.flip)).toBeInstanceOf(ConnectionsGone);
      expect(yield* test.run({ ...request, reason: 'Jiný důvod' }).pipe(Effect.flip)).toBeInstanceOf(ConnectionsGone);
      expect(external.events).toEqual(['administrator', 'action', 'administrator', 'action']);
      expect(test.harness.snapshot().committed).toHaveLength(1);
    }),
  );
}

it.effect('rechecks company administration before replaying a committed archive', () =>
  Effect.gen(function* deniedRetry() {
    const test = yield* fixture();
    external.failStep = 'projection';
    yield* test.run(archive).pipe(Effect.flip);
    external.administrator = false;
    external.events = [];
    expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsForbidden);
    expect(external.events).toEqual(['administrator', 'denied-audit']);
    expect(test.actions).toHaveLength(1);
  }),
);

it.effect('fails closed when denied-attempt auditing fails and performs no Action or cleanup', () =>
  Effect.gen(function* deniedAuditFailure() {
    const test = yield* fixture();
    external.administrator = false;
    external.failStep = 'denied-audit';
    expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsUnavailable);
    expect(external.events).toEqual(['administrator', 'denied-audit']);
    expect(test.actions).toHaveLength(0);
    expect(test.harness.snapshot().committed).toHaveLength(0);
    expect(external.connections).toEqual(['connection-1', 'connection-2']);
    expect(external.proposals).toBe(1);
    expect(external.grants).toBe(2);
    expect(test.state.status).toBe('active');
  }),
);

it.effect('does not turn native permission denial into successful cleanup', () =>
  Effect.gen(function* nativeDenial() {
    const test = yield* fixture({ actionPermission: 'denied' });
    expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsForbidden);
    expect(external.events).toEqual(['administrator', 'action']);
    expect(test.harness.snapshot().committed).toHaveLength(0);
  }),
);

for (const options of [{ member: false }, { exists: false }]) {
  it.effect(`leaves foreign/missing target validation to the real native handler (${Object.keys(options)[0]})`, () =>
    Effect.gen(function* invalidTarget() {
      const test = yield* fixture(options);
      expect(yield* test.run(archive).pipe(Effect.flip)).toBeInstanceOf(ConnectionsInvalid);
      expect(external.events).not.toContain('snapshot');
      expect(external.events).not.toContain('projection');
      expect(external.events).not.toContain('connections');
      expect(test.state.status).toBe('active');
      expect(test.harness.snapshot().committed).toHaveLength(0);
    }),
  );
}

it.effect('keeps native optimistic status conflict enforcement for a fresh request', () =>
  Effect.gen(function* optimisticConflict() {
    const test = yield* fixture();
    test.state.status = 'disabled';
    expect(yield* test.run(disable).pipe(Effect.flip)).toBeInstanceOf(ConnectionsGone);
    expect(external.events).toEqual(['administrator', 'action', 'owner-target', 'owner-membership']);
  }),
);

it.effect('finishes interrupted revocations before withdrawing proposals or removing grants/operators', () =>
  Effect.gen(function* interruptedRevocation() {
    const test = yield* fixture();
    external.failStep = 'connection-2';
    yield* test.run(archive).pipe(Effect.flip);
    expect(external.connections).toEqual(['connection-2']);
    expect(external.proposals).toBe(1);
    expect(external.grants).toBe(2);
    external.events = [];
    yield* test.run(archive);
    expect(external.events).toEqual([
      'administrator',
      'action',
      'projection',
      'connections',
      'connection-2',
      'proposals',
      'withdraw-action',
      'grants',
      'confirm-archived',
    ]);
    expect(test.harness.snapshot().committed).toHaveLength(2);
  }),
);

for (const request of [disable, archive]) {
  it.effect(`propagates native withdrawal Read failure and resumes ${request.operation} cleanup on the same key`, () =>
    Effect.gen(function* withdrawalFailure() {
      const test = yield* fixture();
      external.failStep = 'proposals';
      expect(yield* test.run(request).pipe(Effect.flip)).toBeInstanceOf(ConnectionsUnavailable);
      expect(test.state.status).toBe(request.operation === 'delete' ? 'archived' : 'disabled');
      expect(external.connections).toEqual([]);
      expect(external.proposals).toBe(1);
      expect(external.grants).toBe(2);
      expect(external.events).not.toContain('grants');
      expect(external.events).not.toContain('confirm-archived');
      expect(test.proposalActions).toHaveLength(0);
      external.events = [];
      yield* test.run(request);
      expect(external.events.slice(0, 6)).toEqual([
        'administrator',
        'action',
        'projection',
        'connections',
        'proposals',
        'withdraw-action',
      ]);
      expect(external.proposals).toBe(0);
      expect(test.harness.snapshot().committed).toHaveLength(2);
      if (request.operation === 'delete') {
        expect(external.events.at(-1)).toBe('confirm-archived');
      }
    }),
  );
}

it.effect(
  'withdraws every native-discovered batch across pages without fabricating targets or changing ingress identity',
  () =>
    Effect.gen(function* completeWithdrawal() {
      const test = yield* fixture({ batchCount: 40 });
      const batchIds = test.state.rows.map(({ batchId }) => batchId);
      yield* test.run(archive);
      const recoveryInputs = batchIds.map((batchId) => ({
        idempotencyKey: proposalSubcommandKey(transport.idempotencyKey, 'withdraw-pending-of-agent', batchId),
        mode: 'command-recovery',
        payload: {
          batchId,
          note: `Agent byl smazán: ${archive.reason}`,
          operation: 'withdraw-pending-of-agent',
        },
      }));
      expect(test.readInputs.map(({ input }) => input)).toEqual([
        { agentPrincipalId: agentId, mode: 'withdrawal-batches' },
        ...recoveryInputs.slice(0, 31),
        { afterBatchId: batchIds[30], agentPrincipalId: agentId, mode: 'withdrawal-batches' },
        ...recoveryInputs.slice(31),
      ]);
      for (const read of test.readInputs) {
        expect(read.principal).toBe(principal);
        expect(read.transport).toBe(readTransport);
      }
      expect(test.proposalActions.map(({ payload }) => payload)).toEqual(
        batchIds.map((batchId) => ({
          batchId,
          note: `Agent byl smazán: ${archive.reason}`,
          operation: 'withdraw-pending-of-agent',
        })),
      );
      for (const [index, action] of test.proposalActions.entries()) {
        expect(action.principal).toBe(principal);
        const batchId = batchIds[index];
        if (batchId === undefined) {
          throw new TypeError('Native discovery returned an unexpected batch');
        }
        expect(action.transport).toEqual({
          correlationId: transport.correlationId,
          idempotencyKey: proposalSubcommandKey(transport.idempotencyKey, 'withdraw-pending-of-agent', batchId),
        });
      }
      expect(
        test.state.rows.every((row) => row.status === 'rejected' && row.decidedByPrincipalId === principal.principalId),
      ).toBe(true);
      expect(test.harness.snapshot().committed).toHaveLength(41);
      expect(test.reads.snapshot().evidenceWrites).toBe(42);
      expect(external.events.at(-1)).toBe('confirm-archived');
    }),
);

it.effect('keeps a native claimed sibling intact while withdrawing unclaimed proposals in its complete batch', () =>
  Effect.gen(function* claimedSibling() {
    const test = yield* fixture({ claimedSibling: true });
    const claimed = test.state.rows.find((row) => row.decidedAt !== null);
    yield* test.run(disable);
    expect(test.state.rows.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(test.state.rows.find((row) => row.proposalId === claimed?.proposalId)).toEqual(claimed);
    expect(test.proposalActions).toHaveLength(1);
    expect(test.harness.snapshot().committed).toHaveLength(2);
  }),
);

it('requires an explicit non-archived expected status in the actual delete wire contract', () => {
  const valid = Schema.is(ManageAgentEntityRequestSchema);
  expect(valid(archive)).toBe(true);
  expect(valid({ ...archive, expectedStatus: 'disabled' })).toBe(true);
  expect(valid({ operation: 'delete', principalId: agentId, reason: 'Důvod' })).toBe(false);
  expect(valid({ ...archive, expectedStatus: 'archived' })).toBe(false);
  expect(valid({ ...archive, expectedStatus: null })).toBe(false);
  expect(valid({ ...archive, expectedStatus: 'inactive' })).toBe(false);
});
