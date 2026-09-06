import { expect, rstest, test } from '@rstest/core';
import { Effect, Layer } from 'effect';
import * as actualCore from '@app/core-runtime' with { rstest: 'importActual' };
import * as actualEffect from 'effect' with { rstest: 'importActual' };
import * as actualDrizzle from 'drizzle-orm/node-postgres' with { rstest: 'importActual' };
import * as actualCoreDatabase from '../../../../packages/core-runtime/src/db/client.ts' with {
  rstest: 'importActual',
};
import * as actualCoreSchema from '../../../../packages/core-runtime/src/db/schema.ts' with {
  rstest: 'importActual',
};
import * as actualPermissions from '../../../../packages/core-runtime/src/permissions/service.ts' with {
  rstest: 'importActual',
};
import * as actualAuthConfig from '../../api/auth/config.ts' with { rstest: 'importActual' };
import * as actualAuthDatabase from '../../api/auth/db/client.ts' with { rstest: 'importActual' };
import * as actualAuthSchema from '../../api/auth/db/schema.ts' with { rstest: 'importActual' };
import {
  ContextAccess,
  TenantModuleStateService,
  buildInstalledModuleCatalog,
} from '@app/core-runtime';
import type {
  ContextAccessService,
  ModuleEntrypointGatewayService,
  ModuleStateGateService,
  OperationalScopeResolverService,
} from '@app/core-runtime';
import type { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { AuthenticationService } from '../../api/auth/service.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';

type Database = (typeof CoreDatabase)['Service'];
interface RuntimeObservation {
  readonly access: ContextAccessService;
  readonly database: Database;
  readonly gateway: ModuleEntrypointGatewayService;
  readonly resolver: OperationalScopeResolverService;
  readonly runtime: unknown;
}

const observed = rstest.hoisted(
  (): {
    actions: RuntimeObservation[];
    reads: RuntimeObservation[];
    databases: Database[];
    resolvers: Map<
      OperationalScopeResolverService,
      { access: ContextAccessService; database: Database }
    >;
    gates: Map<ModuleStateGateService, (typeof TenantModuleStateService)['Service']>;
    gateways: Map<ModuleEntrypointGatewayService, ModuleStateGateService>;
    defaultAccess?: ContextAccessService;
  } => ({
    actions: [],
    reads: [],
    databases: [],
    resolvers: new Map(),
    gates: new Map(),
    gateways: new Map(),
  }),
);

// Keep the real dependency-transparent runtime layers; replace only external resources.
// Taps record the exact inputs received by each consumer without changing layer outputs.
rstest.doMock('@app/core-runtime', () => {
  const core = actualCore;
  const { Context, Effect, Layer } = actualEffect;
  const { drizzle } = actualDrizzle;
  const { CoreDatabase } = actualCoreDatabase;
  const { coreRelations } = actualCoreSchema;
  const { ActionPermission } = actualPermissions;
  const defaultAccess: ContextAccessService = {
    legalEntities: () => Effect.succeed([]),
    modules: () => Effect.succeed([]),
    resources: () => Effect.succeed([]),
    tenants: () => Effect.succeed([]),
  };
  observed.defaultAccess = defaultAccess;
  const recordRuntime = (target: RuntimeObservation[], runtime: unknown) =>
    Effect.gen(function* () {
      target.push({
        runtime,
        access: yield* core.ContextAccess,
        database: yield* CoreDatabase,
        gateway: yield* core.ModuleEntrypointGateway,
        resolver: yield* core.OperationalScopeResolver,
      });
    });
  return {
    ...core,
    CorePersistenceLive: Layer.effect(
      CoreDatabase,
      Effect.sync(() => {
        const database = { executor: drizzle.mock({ relations: coreRelations }) };
        observed.databases.push(database);
        return database;
      }),
    ),
    ContextAccessLive: Layer.succeed(core.ContextAccess, defaultAccess),
    ActionPermissionLive: Layer.succeed(ActionPermission, {
      checkActionPermission: () => Effect.succeed('allowed'),
    }),
    ActionRuntimeLive: core.ActionRuntimeLive.pipe(
      Layer.tap((services) =>
        recordRuntime(observed.actions, Context.get(services, core.ActionRuntime)),
      ),
    ),
    ReadRuntimeLive: core.ReadRuntimeLive.pipe(
      Layer.tap((services) =>
        recordRuntime(observed.reads, Context.get(services, core.ReadRuntime)),
      ),
    ),
    OperationalScopeResolverLive: core.OperationalScopeResolverLive.pipe(
      Layer.tap((services) =>
        Effect.gen(function* () {
          observed.resolvers.set(Context.get(services, core.OperationalScopeResolver), {
            access: yield* core.ContextAccess,
            database: yield* CoreDatabase,
          });
        }),
      ),
    ),
    ModuleEntrypointGatewayLive: core.ModuleEntrypointGatewayLive.pipe(
      Layer.tap((services) =>
        Effect.gen(function* () {
          observed.gateways.set(
            Context.get(services, core.ModuleEntrypointGateway),
            yield* core.ModuleStateGate,
          );
        }),
      ),
    ),
    ModuleStateGateLive: core.ModuleStateGateLive.pipe(
      Layer.tap((services) =>
        Effect.gen(function* () {
          observed.gates.set(
            Context.get(services, core.ModuleStateGate),
            yield* core.TenantModuleStateService,
          );
        }),
      ),
    ),
  };
});

rstest.doMock('../../api/auth/runtime-infrastructure.ts', () => {
  const { Effect, Layer } = actualEffect;
  const { drizzle } = actualDrizzle;
  const { AuthConfig, parseAuthConfig } = actualAuthConfig;
  const { AuthDatabase } = actualAuthDatabase;
  const { authRelations } = actualAuthSchema;
  return {
    AuthPersistenceLive: Layer.mergeAll(
      Layer.effect(
        AuthConfig,
        parseAuthConfig({
          BETTER_AUTH_SECRET: 'unit-test-only-secret-with-more-than-32-characters',
          BETTER_AUTH_URL: 'http://localhost:3020',
          DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
        }).pipe(Effect.orDie),
      ),
      Layer.succeed(AuthDatabase, { executor: drizzle.mock({ relations: authRelations }) }),
    ),
  };
});

const unused = () => Effect.die('Composition probes must not execute authentication or SQL');
const authenticationLayer = Layer.succeed(AuthenticationService, {
  availableTenants: unused,
  createFixtureUser: unused,
  currentSession: unused,
  resolveShellContext: unused,
  resolveTenantContext: unused,
  signIn: unused,
  signOut: unused,
  switchLegalEntity: unused,
  switchTenant: unused,
});

const access = (decision: 'allowed' | 'denied'): ContextAccessService => ({
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ key, decision }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ key, decision }))),
  resources: () => Effect.succeed([]),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ key, decision }))),
});

const moduleStates = (): (typeof TenantModuleStateService)['Service'] => ({
  getTenantModuleStates: () => Effect.succeed([]),
  listActiveTenantModules: () => Effect.succeed([]),
  listTenantModuleStates: () => Effect.succeed([]),
});

test('independent concurrent Shell roots preserve ContextAccess, Core persistence and module-state identity', async () => {
  const { makeShellAuthenticationApiRuntime } = await import('../../api/index.ts');
  const firstAccess = access('allowed');
  const secondAccess = access('denied');
  const firstStates = moduleStates();
  const secondStates = moduleStates();
  const defaultStates = moduleStates();
  const createRoot = (
    states: (typeof TenantModuleStateService)['Service'],
    selectedAccess?: ContextAccessService,
  ) =>
    makeShellAuthenticationApiRuntime(
      authenticationLayer,
      {
        currentTimeSeconds: Effect.succeed(1_700_000_000),
        generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
        loadAudiences: Effect.succeed(new Set<string>()),
        loadConfig: parseGatewayIssuerConfig({}),
      },
      Layer.succeed(TenantModuleStateService, states),
      Effect.succeed(buildInstalledModuleCatalog([])),
      false,
      selectedAccess === undefined ? undefined : Layer.succeed(ContextAccess, selectedAccess),
    ).createHandler();
  const handlers = [
    createRoot(firstStates, firstAccess),
    createRoot(secondStates, secondAccess),
    createRoot(defaultStates),
  ];
  try {
    const responses = await Promise.all(
      handlers.map(({ handler }) =>
        handler(new Request('http://localhost:3020/__runtime_composition_probe')),
      ),
    );
    expect(responses.map(({ status }) => status)).toEqual([404, 404, 404]);
    // A tap runs for each consumer of a memoized layer; count actual service identities.
    expect(new Set(observed.actions.map(({ runtime }) => runtime)).size).toBe(3);
    expect(new Set(observed.reads.map(({ runtime }) => runtime)).size).toBe(3);
    expect(observed.databases).toHaveLength(3);
    expect(observed.resolvers.size).toBe(3);
    expect(observed.gates.size).toBe(3);
    expect(observed.gateways.size).toBe(3);
    const selections = [
      { access: firstAccess, states: firstStates },
      { access: secondAccess, states: secondStates },
      { access: observed.defaultAccess, states: defaultStates },
    ];
    for (const selection of selections) {
      const action = observed.actions.find((runtime) => runtime.access === selection.access);
      const read = observed.reads.find((runtime) => runtime.access === selection.access);
      expect(action).toBeDefined();
      expect(read).toBeDefined();
      if (action === undefined || read === undefined) {
        throw new Error('A configured root lost its selected ContextAccess');
      }
      for (const observation of observed.actions.filter(
        ({ access }) => access === selection.access,
      )) {
        expect(observation).toEqual(action);
      }
      for (const observation of observed.reads.filter(
        ({ access }) => access === selection.access,
      )) {
        expect(observation).toEqual(read);
      }
      expect(action.database).toBe(read.database);
      expect(observed.databases).toContain(action.database);
      expect(action.resolver).toBe(read.resolver);
      expect(action.gateway).toBe(read.gateway);
      const resolver = observed.resolvers.get(action.resolver);
      expect(resolver?.access).toBe(selection.access);
      expect(resolver?.database).toBe(action.database);
      const gate = observed.gateways.get(action.gateway);
      expect(gate).toBeDefined();
      if (gate === undefined) {
        throw new Error('A runtime gateway lost its configured module-state gate');
      }
      expect(observed.gates.get(gate)).toBe(selection.states);
    }
  } finally {
    await Promise.all(handlers.map(({ dispose }) => dispose()));
  }
});
