import { ActionRuntime, PrincipalResolver } from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { PrincipalResolverService } from '@app/core-runtime';
import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { ConfigProvider, Context, Effect, Layer, Option, Redacted, Sink, Stream } from 'effect' with {
  rstest: 'importActual',
};
import { FetchHttpClient } from 'effect/http';
import { afterAll, expect, it, rs } from 'effect-rstest';

import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node' with { rstest: 'importActual' };
import actualNodeFs from 'node:fs' with { rstest: 'importActual' };
import { Writable } from 'node:stream' with { rstest: 'importActual' };

import type { ApiKeyServiceContract } from '../../api/auth/api-key-service.ts';
import type { IdentityLifecycleService } from '../../api/auth/identity-lifecycle.ts';
import { serve } from '../support/preproposal-basis-identity.fixture.ts';

const fixture = rs.hoisted(() => {
  const calls: string[] = [];
  const frames: string[] = [];
  let coreDatabase: Context.Service<{ readonly executor: object }, { readonly executor: object }> | undefined;
  return {
    calls,
    /** The one Core client tag both mocks share; created on first use, once the mock factories run. */
    coreDatabase: () => {
      coreDatabase ??= Context.Service<{ readonly executor: object }>('PreproposalContextTest/CoreDatabase');
      return coreDatabase;
    },
    database: `ontos_test_party_gateway_${'a'.repeat(32)}`,
    frames,
    /** The calling modules the identity child asks the platform to provision, and their platform principals. */
    modules: [
      ['catalog', '77777777-7777-4777-8777-777777777777'],
      ['commerce-customer-context', '33333333-3333-4333-8333-333333333333'],
      ['commerce-market-catalog', '66666666-6666-4666-8666-666666666666'],
      ['pricing', '44444444-4444-4444-8444-444444444444'],
    ] as const,
    principalId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
  };
});

rs.mock('@app/core-runtime/db/client', () => ({ CoreDatabase: fixture.coreDatabase() }));
rs.mock('@app/core-runtime/auth/module-credentials', () => ({
  loadModuleCredentialEnrolment: () =>
    Effect.sync(() => {
      fixture.calls.push('load-module-credential-enrolment');
      return fixture.modules.map(([appId, principalId]) => ({
        appId,
        authBindingId: '99999999-9999-4999-8999-999999999999',
        boundAt: new Date(0),
        principalId,
        providerKeyId: `fixture-${appId}-provider-key`,
      }));
    }),
}));
rs.mock('../../api/auth/module-credential-provisioning.service.ts', () => ({
  provisionModuleCredentials: ({
    appIds,
    release,
  }: {
    readonly appIds: readonly string[];
    readonly release: { readonly compositionRevision: string };
  }) =>
    Effect.sync(() => {
      expect(appIds).toEqual(fixture.modules.map(([appId]) => appId));
      expect(release.compositionRevision).toBe('a'.repeat(64));
      fixture.calls.push('provision-module-credentials');
      return {
        credentials: new Map(appIds.map((appId) => [appId, Redacted.make(`inert-${appId}-key`)] as const)),
        failedAppIds: [],
        providerKeyIds: new Set(appIds.map((appId) => `fixture-${appId}-provider-key`)),
      };
    }),
}));
rs.mock('@app/core-runtime', () => {
  const actionRuntime = Context.Service<object>('PreproposalContextTest/ActionRuntime');
  const legalEntityContext = Context.Service<object>('PreproposalContextTest/LegalEntityContext');
  const principalResolver = Context.Service<object>('PreproposalContextTest/PrincipalResolver');
  return {
    ActionRuntime: actionRuntime,
    ContextAccessLive: Layer.empty,
    // Core persistence provides the one CoreDatabase the identity child reads.
    CorePersistenceLive: Layer.succeed(fixture.coreDatabase(), { executor: {} }),
    DatabaseConfig: Context.Service<object>('PreproposalContextTest/DatabaseConfig'),
    defineDatabaseIdentityEnrollment: () => ({}),
    LegalEntityContext: legalEntityContext,
    LegalEntityContextLive: Layer.succeed(legalEntityContext, {}),
    makeActionRuntimeLive: () => Layer.effect(actionRuntime, AuthenticationNamespaceRegistry.pipe(Effect.as({}))),
    makeDatabaseIdentityEnrollmentLive: () => Layer.empty,
    parseDatabaseConfig: () => Effect.succeed({ database: fixture.database, host: 'localhost', user: 'ontos_runtime' }),
    PrincipalResolver: principalResolver,
    PrincipalResolverLive: () =>
      Layer.succeed(principalResolver, {
        resolveBetterAuthApiKey: (providerKeyId) =>
          Effect.sync(() => {
            expect(providerKeyId).toBe('fixture-buyer-provider-key');
            fixture.calls.push('resolve-buyer-binding');
            return {
              authBindingId: '55555555-5555-4555-8555-555555555555',
              displayName: 'Unit buyer',
              principalId: fixture.principalId,
              principalKind: 'human',
              tenantId: fixture.tenantId,
            };
          }),
      } satisfies Pick<PrincipalResolverService, 'resolveBetterAuthApiKey'>),
    TenantModuleStateServiceLive: Layer.empty,
  };
});
rs.mock('@app/core-runtime/access/enforcement', () => {
  const accessDecisionGate = Context.Service('PreproposalContextTest/AccessDecisionGate');
  const allowed = {
    evidence: [],
    outcome: 'ALLOWED',
    reasons: [{ code: 'allow.granted' }],
    selectors: [],
  };
  return {
    AccessDecisionGate: accessDecisionGate,
    makeTestAccessDecision: () => ({
      askedDecisions: [],
      askedLists: [],
      askedSelectableLegalEntities: [],
      decide: () => Effect.succeed(allowed),
      decideMany: (inputs: readonly unknown[]) => Effect.succeed(inputs.map(() => allowed)),
      list: () => Effect.succeed({ decision: allowed, predicate: { groups: [] } }),
      selectableLegalEntities: () => Effect.succeed([]),
    }),
  };
});
// The fixture scripts its one access gate over the Tenant's own companies; the suite provides that gate.
rs.mock('@app/core-runtime/testing/access-gate', () => ({
  makeTestAccessGateLayers: () =>
    Layer.succeed(AccessDecisionGate, makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } })),
}));
rs.mock('@app/core-runtime/actions/runtime-wiring', () => ({
  ActionPermissionLive: Layer.empty,
  ActionRepositoryLive: Layer.empty,
  ModuleEntrypointGatewayLive: Layer.empty,
  ModuleStateGateLive: Layer.empty,
  OperationalScopeResolverLive: Layer.empty,
}));
rs.mock('../../api/modules/installed-module-catalog.ts', () => ({
  // The release the fixture's composition serves; the platform attests each module credential for it.
  installedModuleCatalog: Effect.succeed({ composition: { revision: 'a'.repeat(64) }, contracts: [] }),
  ShellInstalledModuleCatalogLive: Layer.empty,
}));
rs.mock('@app/core-runtime/modules/active-application-composition', () => ({
  ActiveApplicationCompositionConfigLive: Layer.empty,
}));
rs.mock('@app/core-runtime/modules/active-application-composition-source', () => ({
  ActiveApplicationCompositionSourceLive: Layer.empty,
}));
rs.mock('@effect/sql-pg', () => ({
  PgClient: {
    make: () =>
      Effect.succeed({
        unsafe: () =>
          Effect.succeed([
            {
              database: fixture.database,
              oid: 1234,
              owner: 'fixture_owner',
              role: 'ontos_runtime',
              unsafe: false,
            },
          ]),
      }),
  },
}));
rs.mock('../../api/auth/config.ts', () => ({
  AuthConfig: Context.Service<object>('PreproposalContextTest/AuthConfig'),
  parseAuthConfig: () => Effect.succeed({ baseUrl: 'https://fixture.invalid' }),
}));
rs.mock('../../api/auth/db/client.ts', () => ({
  AuthDatabase: Context.Service<object>('PreproposalContextTest/AuthDatabase'),
  makeAuthDatabase: () => Effect.succeed({}),
}));
const requireCommandContext = (operation: string) =>
  Effect.gen(function* checkCommandContext() {
    const registry = yield* Effect.serviceOption(AuthenticationNamespaceRegistry);
    expect(Option.isSome(registry)).toBe(true);
    const service = yield* Effect.fromOption(registry);
    const registration = yield* service
      .lookup(STAFF_AUTHENTICATION_NAMESPACE_ID)
      .pipe(Effect.flatMap(Effect.fromOption));
    expect(registration.allowedAudiences).toEqual(['shell-super-app']);
    expect(registration.requiresOperationAdmission).toBe(false);
    expect(Option.isSome(yield* Effect.serviceOption(ActionRuntime))).toBe(true);
    expect(Option.isSome(yield* Effect.serviceOption(PrincipalResolver))).toBe(true);
    fixture.calls.push(operation);
  });

rs.mock('../../api/auth/service.ts', () => ({
  makeAuthenticationService: () =>
    requireCommandContext('authentication-construction').pipe(
      Effect.as({
        createFixtureUser: () => Effect.succeed('fixture-provider-user'),
        resolveShellContext: () =>
          Effect.succeed({
            principal: {
              authContextRef: 'better-auth-session:fixture-session',
              legalEntityId: '88888888-8888-4888-8888-888888888888',
              principalId: fixture.principalId,
              tenantId: fixture.tenantId,
            },
            state: 'authenticated',
          }),
        resolveTenantContext: () =>
          Effect.succeed({
            principal: {
              authContextRef: 'better-auth-session:fixture-tenant-session',
              principalId: fixture.principalId,
              tenantId: fixture.tenantId,
            },
            state: 'authenticated',
          }),
        signIn: () =>
          Effect.succeed({
            identity: { principalId: fixture.principalId, tenantId: fixture.tenantId },
            setCookieHeaders: ['fixture=session'],
          }),
      }),
    ),
}));
rs.mock('../support/shell-authentication.ts', () => ({ shellAuthenticationFrameworkLive: () => Layer.empty }));
rs.mock('../../api/auth/api-key-service.ts', () => ({
  ApiKeyService: Context.Service<object>('PreproposalContextTest/ApiKeyService'),
  makeApiKeyService: () =>
    Effect.succeed({
      verify: (rawKey) =>
        Effect.sync(() => {
          if (rawKey === 'inert-Preproposal original buyer-key') {
            fixture.calls.push('verify-buyer-key');
            return { providerKeyId: 'fixture-buyer-provider-key' };
          }
          // No module key is ever verified here: the platform issued and bound them.
          return expect.unreachable(`unexpected key verification for ${rawKey.length} characters`);
        }),
    } satisfies Pick<ApiKeyServiceContract, 'verify'>),
}));

rs.mock('../../api/auth/identity-lifecycle.ts', () => ({
  makeIdentityLifecycleService: () => ({
    issue: ({ managedPrincipalId, name }: Parameters<IdentityLifecycleService['issue']>[0]) =>
      requireCommandContext('issue').pipe(
        Effect.andThen(
          Effect.sync(() => {
            // Only the buyer's own key is issued through the identity lifecycle.
            expect(name).toBe('Preproposal original buyer');
            expect(managedPrincipalId).toBeUndefined();
            return {
              authBindingId: '55555555-5555-4555-8555-555555555555',
              cleanupPending: false,
              secret: Redacted.make(`inert-${name}-key`),
            };
          }),
        ),
      ),
  }),
}));
rs.mock('node:fs', () => ({
  ...actualNodeFs,
  createReadStream: rs.fn(),
  createWriteStream: () =>
    new Writable({
      write(_chunk, _encoding, complete) {
        complete();
      },
    }),
}));
rs.mock('@effect/platform-node', () => ({
  NodeCrypto,
  NodeRuntime,
  NodeServices,
  NodeSink: {
    fromWritable: () =>
      Sink.forEachArray((lines: readonly string[]) =>
        Effect.sync(() => {
          fixture.frames.push(...lines);
        }),
      ),
  },
  NodeStream: {
    fromReadable: () =>
      Stream.make(
        new TextEncoder().encode(
          [
            JSON.stringify({
              buyerPrincipalId: fixture.principalId,
              operation: 'CREATE_SERVICE_KEYS',
              protocol: 'ontos.shell.preproposal-basis.identity.v1',
              tenantId: fixture.tenantId,
            }),
            JSON.stringify({ operation: 'STOP', protocol: 'ontos.shell.preproposal-basis.identity.v1' }),
          ].join('\n'),
        ),
      ),
  },
}));

it.effect('retains the staff registry for the buyer and asks the platform for every calling module credential', () =>
  Effect.gen(function* actualFixtureContext() {
    fixture.calls.length = 0;
    fixture.frames.length = 0;
    yield* serve;
    expect(fixture.calls).toEqual([
      'authentication-construction',
      'issue',
      'verify-buyer-key',
      'resolve-buyer-binding',
      'provision-module-credentials',
      'load-module-credential-enrolment',
    ]);
    expect(fixture.frames).toHaveLength(3);
    expect(fixture.frames[1]).toContain('SERVICE_KEYS_CREATED');
    expect(fixture.frames[1]).toContain(
      `"buyer":{"authBindingId":"55555555-5555-4555-8555-555555555555","principalId":"${fixture.principalId}"`,
    );
    for (const [appId, principalId] of fixture.modules) {
      expect(fixture.frames[1]).toContain(`fixture-${appId}-provider-key`);
      expect(fixture.frames[1]).toContain(principalId);
    }
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer, FetchHttpClient.layer)),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({
        BETTER_AUTH_SECRET: 'inert-test-auth-configuration',
        BETTER_AUTH_URL: 'https://fixture.invalid',
        DATABASE_URL: `postgres://ontos_runtime:inert@localhost/${fixture.database}`,
        ONTOS_PREPROPOSAL_DATABASE_OID: '1234',
        ONTOS_PREPROPOSAL_DATABASE_OWNER: 'fixture_owner',
        ONTOS_PREPROPOSAL_OWNED_DATABASE: fixture.database,
        ONTOS_PREPROPOSAL_SOURCE_DATABASE: 'source_database',
      }),
    ),
  ),
);

// With `isolate: false` one module registry is shared by every file a worker runs, so these
// replacements outlive this file and would leak into whatever runs next. Remove them and drop the
// modules they replaced, so the next file evaluates the real implementations.
afterAll(() => {
  rs.doUnmock('@app/core-runtime');
  rs.doUnmock('@app/core-runtime/db/client');
  rs.doUnmock('@app/core-runtime/auth/module-credentials');
  rs.doUnmock('../../api/auth/module-credential-provisioning.service.ts');
  rs.doUnmock('@app/core-runtime/actions/runtime-wiring');
  rs.doUnmock('@app/core-runtime/modules/active-application-composition');
  rs.doUnmock('@app/core-runtime/modules/active-application-composition-source');
  rs.doUnmock('@effect/sql-pg');
  rs.doUnmock('../../api/auth/config.ts');
  rs.doUnmock('../../api/auth/db/client.ts');
  rs.doUnmock('../../api/auth/service.ts');
  rs.doUnmock('../../api/auth/api-key-service.ts');
  rs.doUnmock('../../api/auth/identity-lifecycle.ts');
  rs.doUnmock('node:fs');
  rs.doUnmock('@effect/platform-node');
  rs.resetModules();
});
