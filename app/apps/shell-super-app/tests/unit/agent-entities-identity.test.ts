import { Effect, Layer, Option } from 'effect' with { rstest: 'importActual' };
import { ActionRuntime, configureAgentAction, ContextAccess } from '@app/core-runtime';
import type { ActionRuntimeService, withPostgresSessionAdvisoryLock } from '@app/core-runtime';
import { ActionAuthorizationLifecycle } from '@app/core-runtime/outbox/core-system-worker';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import type { ManageAgentEntityRequest } from '@app/shared-contracts/agent-access';
import { expect, it, rs } from 'effect-rstest';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';

import {
  bindActionTestServices,
  makeActionTestHarness,
} from '../../../../packages/core-runtime/src/testing/actions.ts';
import { installOperationalScopeAt } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../../../packages/core-runtime/src/db/database-identity-manifest.ts';
import { DatabaseIdentityEnrollmentContext } from '../../../../packages/core-runtime/src/db/database-identities.ts';
import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import { manageAgentEntity } from '../../api/auth/agent-entities.ts';
import { AgentActionRequestIdentity } from '../../api/auth/agent-action-request-identity.ts';
import { AgentReadRequestIdentity } from '../../api/auth/agent-request-identity.ts';
import { AuthDatabase } from '../../api/auth/db/client.ts';
import { AuthConfig } from '../../api/auth/config.ts';
import { StaffAuthenticationNamespaceRegistryLive } from '../../api/auth/authentication-namespace-registry.ts';
import { derivedUuid } from '../../api/auth/demo-accounts.ts' with { rstest: 'importActual' };
import { agentModuleOptions, agentRolePreset } from '../../api/auth/agent-entities-model.ts' with {
  rstest: 'importActual',
};
import type { DemoAccountCaller } from '../../api/auth/demo-accounts.ts';
import { makeInstalledModuleCatalogLayer } from '../../api/modules/installed-module-catalog.ts';
import type { ConnectionsAdminDeps } from '../../api/oauth-connections-admin/ports.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
import { nativeDemoAccountTestServices } from '../support/native-demo-account-services.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const templateReads = rs.hoisted(() => {
  const entries: { readonly caller: DemoAccountCaller; readonly transport: { readonly correlationId: string } }[] = [];
  return entries;
});

// Keep the real consumer, Action descriptors and principal derivation; replace external authority and lock IO.
rs.mock('../../../../packages/core-runtime/src/install/demo-account-administration.ts', () => ({
  get openDemoAccountGrants() {
    return Effect.succeed({ rolePolicyOf: () => Effect.succeed([]) });
  },
}));
rs.mock('../../../../packages/core-runtime/src/db/session-advisory-lock.ts', () => ({
  withPostgresSessionAdvisoryLock: <A, E, R>(
    _connection: Parameters<typeof withPostgresSessionAdvisoryLock>[0],
    _key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.yieldNow.pipe(Effect.andThen(() => effect)),
}));
rs.mock('../../api/auth/demo-accounts.ts', () => ({
  auditForbiddenAttempt: () => Effect.void,
  auditTrail: () => Effect.succeed([]),
  companyRoleTemplates: (selected: DemoAccountCaller, readTransport: { readonly correlationId: string }) =>
    Effect.sync(() => {
      templateReads.push({ caller: selected, transport: readTransport });
      return [];
    }),
  get derivedUuid() {
    return derivedUuid;
  },
  requireAdministrator: () => Effect.void,
}));
rs.mock('../../api/auth/agent-entities-model.ts', () => ({
  agentDraftProblem: () => null,
  get agentModuleOptions() {
    return agentModuleOptions;
  },
  get agentRolePreset() {
    return agentRolePreset;
  },
}));

const principal: DemoAccountCaller['principal'] = {
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:agent-identity-test',
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const caller: DemoAccountCaller = { legalName: 'Company', principal };
const create: ManageAgentEntityRequest = {
  description: null,
  displayName: 'Agent',
  modules: [{ access: 'write', moduleId: 'fixture.notes' }],
  operation: 'create',
  operatorPrincipalIds: [principal.principalId],
  ownerPrincipalId: principal.principalId,
  writePolicy: 'approval',
};
const transport = { correlationId: 'original-action-correlation', idempotencyKey: 'original-client-key' };
const expectedId = derivedUuid(`${principal.tenantId}:${principal.legalEntityId}:${transport.idempotencyKey}:agent`);

const fixture = (selected: DemoAccountCaller, principalId: string) =>
  Effect.gen(function* identityFixture() {
    const composition = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'notes', moduleId: 'fixture.notes' }),
    ]);
    const events: string[] = [];
    let persisted = false;
    const owner = yield* makeWithDefaults({}).pipe(
      Effect.provide(
        scriptedPgClientLayer(
          Effect.succeed(
            testSqlConnection((sql, params) =>
              Effect.sync(() => {
                if (sql.includes('set_config')) {
                  expect(params).toEqual([selected.principal.tenantId, selected.principal.legalEntityId]);
                  return [
                    {
                      legal_entity_id: selected.principal.legalEntityId,
                      operation_at: new Date(0),
                      role: SHARED_RUNTIME_IDENTITY.role,
                      tenant_id: selected.principal.tenantId,
                    },
                  ];
                }
                expect(params).toContain(selected.principal.tenantId);
                if (sql.startsWith('select') && sql.includes('inner join')) {
                  expect(params).toContain(selected.principal.legalEntityId);
                  expect(params).toContain(selected.principal.principalId);
                  return [{ principalId: selected.principal.principalId }];
                }
                if (sql.startsWith('select') && sql.includes('"principals"')) {
                  expect(params).toContain(principalId);
                  expect(sql).toContain('for update');
                  return persisted ? [{ displayName: 'Agent', kind: 'agent', status: 'active' }] : [];
                }
                if (sql.startsWith('insert') && sql.includes('"principals"')) {
                  expect(params).toContain(principalId);
                  expect(params).toContain('agent');
                  expect(params).toContain('active');
                  persisted = true;
                  return [];
                }
                if (sql.startsWith('insert') && sql.includes('"principal_company_memberships"')) {
                  expect(params).toContain(principalId);
                  expect(params).toContain(selected.principal.legalEntityId);
                  return [];
                }
                throw new Error(`Unexpected native create SQL: ${sql}`);
              }),
            ),
          ),
        ).pipe(Layer.provideMerge(Reactivity.layer)),
      ),
    );
    const { scoped } = yield* installOperationalScopeAt(
      owner,
      { ...selected.principal, correlationId: transport.correlationId },
      FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    );
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      services: [bindActionTestServices(configureAgentAction, { transaction: scoped })],
    });
    const principals: unknown[] = [];
    const actions = { ...harness, principals };
    const transports: unknown[] = [];
    const runtime: ActionRuntimeService = {
      ...harness.runtime,
      runAction: (input) => {
        events.push('action');
        principals.push(input.principal);
        transports.push(input.transport);
        return harness.runtime.runAction(input);
      },
    };
    const deps: ConnectionsAdminDeps<never> = {
      directory: {
        confirmArchived: () => Effect.die('Unexpected archive'),
        replaceOperators: (input) =>
          Effect.sync(() => {
            expect(input.agentPrincipalId).toBe(principalId);
            events.push('operators');
          }),
        snapshot: Effect.sync(() => {
          events.push('snapshot');
          return {
            agents: [],
            members: [selected.principal.principalId],
            people: [{ displayName: 'Person', principalId: selected.principal.principalId }],
          };
        }),
      },
      grants: {
        get: () => Effect.die('Unexpected grant lookup'),
        list: () => Effect.die('Unexpected grant list'),
        revoke: () => Effect.die('Unexpected grant revocation'),
        update: () => Effect.die('Unexpected grant update'),
      },
      mcpUrl: 'https://example.invalid/mcp',
    };
    const nativeServices = yield* nativeDemoAccountTestServices(
      selected,
      transport,
      makeContextAccessDouble('allowed'),
    );
    const run = manageAgentEntity(selected, create, deps).pipe(
      Effect.provide(nativeServices),
      Effect.provide(StaffAuthenticationNamespaceRegistryLive),
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
        reconcilePrincipal: () =>
          Effect.sync(() => {
            events.push('projection');
          }),
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
    return { actions, events, run, transports };
  });

it.effect(
  'preserves the original principal, persisted transport and deterministic create identity through projection',
  () =>
    Effect.gen(function* originalIdentity() {
      const test = yield* fixture(caller, expectedId);
      const result = yield* test.run.pipe(
        Effect.provideService(AgentActionRequestIdentity, transport),
        Effect.provideService(AgentReadRequestIdentity, transport),
      );
      expect(result.principalId).toBe(expectedId);
      expect(test.actions.principals[0]).toBe(principal);
      expect(test.transports[0]).toBe(transport);
      expect(templateReads.at(-1)?.caller).toBe(caller);
      expect(templateReads.at(-1)?.transport).toBe(transport);
      expect(test.events).toEqual(['snapshot', 'action', 'projection', 'snapshot', 'operators']);
      expect(test.actions.snapshot().committed.map(({ actionKey }) => actionKey)).toEqual([
        'core.identity.configure-agent',
      ]);
      expect(test.actions.snapshot().transactionCount).toBe(1);
    }),
);

it.effect(
  'isolates concurrent request identities and selected companies, and repeats the same derived ID on retry',
  () =>
    Effect.gen(function* isolatedRequests() {
      const other: DemoAccountCaller = {
        ...caller,
        principal: { ...principal, legalEntityId: '00000000-0000-4000-8000-000000000006' },
      };
      const otherTransport = { correlationId: 'second-correlation', idempotencyKey: 'second-key' };
      const otherId = derivedUuid(
        `${other.principal.tenantId}:${other.principal.legalEntityId}:${otherTransport.idempotencyKey}:agent`,
      );
      const first = yield* fixture(caller, expectedId);
      const second = yield* fixture(other, otherId);
      const retry = yield* fixture(caller, expectedId);
      const results = yield* Effect.all(
        [
          first.run.pipe(
            Effect.provideService(AgentActionRequestIdentity, transport),
            Effect.provideService(AgentReadRequestIdentity, transport),
          ),
          second.run.pipe(
            Effect.provideService(AgentActionRequestIdentity, otherTransport),
            Effect.provideService(AgentReadRequestIdentity, otherTransport),
          ),
          retry.run.pipe(
            Effect.provideService(AgentActionRequestIdentity, transport),
            Effect.provideService(AgentReadRequestIdentity, transport),
          ),
        ],
        { concurrency: 3 },
      );
      expect(results.map((result) => result.principalId)).toEqual([expectedId, otherId, expectedId]);
      expect(first.transports[0]).toBe(transport);
      expect(second.transports[0]).toBe(otherTransport);
      expect(retry.transports[0]).toBe(transport);
      expect(second.actions.principals[0]).toBe(other.principal);
    }),
);

it.effect('does not let read metadata satisfy the mandatory Action identity service', () =>
  Effect.gen(function* missingActionIdentity() {
    const identity = yield* Effect.serviceOption(AgentActionRequestIdentity).pipe(
      Effect.provideService(AgentReadRequestIdentity, { correlationId: 'read-only' }),
    );
    expect(Option.isNone(identity)).toBe(true);
  }),
);
