import { ActionRuntime, PrincipalResolver } from '@app/core-runtime';
import { AuthenticationNamespaceRegistry } from '@app/core-runtime/auth/external-identity-admission';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { ConfigProvider, Context, Effect, Layer, Option, Redacted, Sink, Stream } from 'effect' with {
  rstest: 'importActual',
};
import { FetchHttpClient } from 'effect/http';
import { expect, it, rs } from 'effect-rstest';

import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node' with { rstest: 'importActual' };
import actualNodeFs from 'node:fs' with { rstest: 'importActual' };
import { Writable } from 'node:stream' with { rstest: 'importActual' };

import { serve } from '../support/preproposal-basis-identity.fixture.ts';

const fixture = rs.hoisted(() => {
  const calls: string[] = [];
  const frames: string[] = [];
  return {
    calls,
    database: `ontos_test_party_gateway_${'a'.repeat(32)}`,
    frames,
    principalId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
  };
});

rs.mock('@app/core-runtime', () => {
  const actionRuntime = Context.Service<object>('PreproposalContextTest/ActionRuntime');
  const principalResolver = Context.Service<object>('PreproposalContextTest/PrincipalResolver');
  return {
    ActionRuntime: actionRuntime,
    ContextAccessLive: Layer.empty,
    CorePersistenceLive: Layer.empty,
    DatabaseConfig: Context.Service<object>('PreproposalContextTest/DatabaseConfig'),
    defineDatabaseIdentityEnrollment: () => ({}),
    LegalEntityContextLive: Layer.empty,
    makeActionRuntimeLive: () => Layer.effect(actionRuntime, AuthenticationNamespaceRegistry.pipe(Effect.as({}))),
    makeDatabaseIdentityEnrollmentLive: () => Layer.empty,
    parseDatabaseConfig: () => Effect.succeed({ database: fixture.database, host: 'localhost', user: 'ontos_runtime' }),
    PrincipalResolver: principalResolver,
    PrincipalResolverLive: () => Layer.succeed(principalResolver, {}),
    TenantModuleStateServiceLive: Layer.empty,
  };
});
rs.mock('@app/core-runtime/actions/runtime-wiring', () => ({
  ActionPermissionLive: Layer.empty,
  ActionRepositoryLive: Layer.empty,
  ModuleEntrypointGatewayLive: Layer.empty,
  ModuleStateGateLive: Layer.empty,
  OperationalScopeResolverLive: Layer.empty,
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
            principal: { principalId: fixture.principalId, tenantId: fixture.tenantId },
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
rs.mock('../../api/auth/api-key-service.ts', () => ({ makeApiKeyService: () => Effect.succeed({}) }));
rs.mock('../support/shell-authentication.ts', () => ({ shellAuthenticationFrameworkLive: () => Layer.empty }));

rs.mock('../../api/auth/identity-lifecycle.ts', () => ({
  makeIdentityLifecycleService: () => ({
    createNonHumanPrincipal: ({ payload }: { payload: { displayName: string } }) =>
      requireCommandContext('create').pipe(
        Effect.as({
          principalId: payload.displayName.endsWith('ccc-reader')
            ? '33333333-3333-4333-8333-333333333333'
            : '44444444-4444-4444-8444-444444444444',
        }),
      ),
    issue: () =>
      requireCommandContext('issue').pipe(
        Effect.as({
          authBindingId: '55555555-5555-4555-8555-555555555555',
          cleanupPending: false,
          secret: Redacted.make('inert-fixture-key'),
        }),
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

it.effect('retains the supported staff registry in the runtime used by both identity lifecycle commands', () =>
  Effect.gen(function* actualFixtureContext() {
    fixture.calls.length = 0;
    fixture.frames.length = 0;
    yield* serve;
    expect(fixture.calls).toEqual(['authentication-construction', 'create', 'issue', 'create', 'issue']);
    expect(fixture.frames).toHaveLength(3);
    expect(fixture.frames[1]).toContain('SERVICE_KEYS_CREATED');
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
