import { expect, it } from '@app/effect-rstest';
import { Effect, Tracer, Predicate } from 'effect';
import {
  MODULE_ENTRYPOINT_ACCESSES,
  decodeTenantModuleEntrypoint,
  defineSystemModuleEntrypoint,
  defineTenantModuleEntrypoint,
} from '../../src/modules/module-entrypoint.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import {
  checkModuleEntrypoint,
  decideModuleStateAccess,
  makeModuleStateGate,
  makeModuleStateSnapshot,
  prepareModuleStateSnapshot,
  tenantStatesAllowingAccess,
} from '../../src/modules/module-state-gate.ts';
import { TENANT_MODULE_STATES } from '../../src/modules/tenant-module-state-service.ts';
import type { TrustedPrincipalContext } from '../../src/actions/context.ts';
import type { ModuleEntrypointAccess } from '../../src/modules/module-entrypoint.ts';
import type {
  TenantModuleState,
  TenantModuleStateServiceContract,
} from '../../src/modules/tenant-module-state-service.ts';

const trustedContext = (tenantId = '20000000-0000-4000-8000-000000000001') =>
  ({
    authBindingId: '30000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:module-state-gate-test',
    authMethod: 'session',
    principalId: '10000000-0000-4000-8000-000000000001',
    tenantId,
  }) satisfies TrustedPrincipalContext;

const makeRecordingTracer = (spans: Tracer.Span[]): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const attributes = new Map<string, unknown>();
      const links = [...options.links];
      let status: Tracer.SpanStatus = { _tag: 'Started', startTime: options.startTime };
      const span: Tracer.Span = {
        _tag: 'Span',
        addLinks: (newLinks) => {
          links.push(...newLinks);
        },
        annotations: options.annotations,
        attribute: (key, value) => {
          attributes.set(key, value);
        },
        attributes,
        end: (endTime, exit) => {
          status = { _tag: 'Ended', endTime, exit, startTime: options.startTime };
        },
        event: () => {
          // This recording tracer's assertions inspect spans, attributes, links, and status only.
        },
        kind: options.kind,
        links,
        name: options.name,
        parent: options.parent,
        sampled: options.sampled,
        spanId: `span-${spans.length + 1}`,
        get status() {
          return status;
        },
        traceId: 'test-trace',
      };
      spans.push(span);
      return span;
    },
  });

const accessSet = (
  ...accesses: readonly ModuleEntrypointAccess[]
): ReadonlySet<ModuleEntrypointAccess> => new Set(accesses);
const expectedAllowed = {
  active: accessSet('background', 'historical_read', 'read', 'write'),
  archived: accessSet('historical_read'),
  deprecated: accessSet('historical_read', 'read'),
  inactive: accessSet('historical_read'),
  quarantined: accessSet(),
  read_only: accessSet('historical_read', 'read'),
  suspended: accessSet('historical_read'),
} satisfies Readonly<Record<TenantModuleState, ReadonlySet<ModuleEntrypointAccess>>>;

it('encodes the exhaustive state/access matrix once, including missing state', () => {
  for (const state of TENANT_MODULE_STATES) {
    for (const access of MODULE_ENTRYPOINT_ACCESSES) {
      expect(decideModuleStateAccess(state, access), `${state}/${access}`).toBe(
        expectedAllowed[state].has(access) ? 'allow' : 'deny',
      );
    }
  }
  for (const access of MODULE_ENTRYPOINT_ACCESSES) {
    expect(decideModuleStateAccess(null, access)).toBe('deny');
    expect(tenantStatesAllowingAccess(access)).toEqual(
      TENANT_MODULE_STATES.filter((state) => expectedAllowed[state].has(access)).toSorted(),
    );
  }
});

it('constructs frozen tenant and explicit system entrypoints and rejects forged combinations', () => {
  const tenant = defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: 'inventory.stock.reserve',
    moduleKey: 'inventory.stock',
    role: 'action',
  });
  const system = defineSystemModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: 'core.modules.change-state',
    moduleKey: 'core.modules',
    role: 'action',
  });
  expect(Object.isFrozen(tenant)).toBe(true);
  expect(tenant.scope).toBe('tenant');
  expect(system.scope).toBe('system');
  expect(() =>
    decodeTenantModuleEntrypoint({
      access: 'read',
      entrypointKey: 'inventory.stock.reserve',
      moduleKey: 'inventory.stock',
      role: 'action',
    }),
  ).toThrow();
  expect(() =>
    defineSystemModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: 'Invalid',
      moduleKey: 'inventory.stock',
      role: 'action',
    }),
  ).toThrow();
  for (const [role, access] of [
    ['page', 'read'],
    ['public_component', 'historical_read'],
    ['api', 'write'],
    ['search', 'historical_read'],
    ['report', 'read'],
    ['worker', 'background'],
  ] as const) {
    expect(
      defineTenantModuleEntrypoint({
        access,
        authorization:
          role === 'worker'
            ? { kind: 'owner_local_background' }
            : { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: `inventory.stock.${role.replace('_', '-')}`,
        moduleKey: 'inventory.stock',
        role,
      }).role,
    ).toBe(role);
  }
});

it.effect(
  'deduplicates one batch, reuses an immutable snapshot, and fails undeclared keys closed',
  () =>
    Effect.gen(function* reuseSnapshot() {
      let reads = 0;
      let observedKeys: readonly string[] = [];
      const service: TenantModuleStateServiceContract = {
        getTenantModuleStates: (_tenantId, moduleKeys) => {
          reads += 1;
          observedKeys = moduleKeys;
          return Effect.succeed(
            moduleKeys.map((moduleKey) => ({
              moduleKey,
              state: moduleKey === 'billing.invoice' ? ('read_only' as const) : ('active' as const),
            })),
          );
        },
        listActiveTenantModules: () => Effect.succeed([]),
        listTenantModuleStates: () => Effect.succeed([]),
      };
      const descriptors = [
        defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'context_permission', permission: 'module.access' },
          entrypointKey: 'inventory.stock.page',
          moduleKey: 'inventory.stock',
          role: 'page',
        }),
        defineTenantModuleEntrypoint({
          access: 'historical_read',
          authorization: { kind: 'context_permission', permission: 'module.access' },
          entrypointKey: 'inventory.stock.report',
          moduleKey: 'inventory.stock',
          role: 'report',
        }),
        defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'context_permission', permission: 'module.access' },
          entrypointKey: 'billing.invoice.search',
          moduleKey: 'billing.invoice',
          role: 'search',
        }),
      ] as const;
      const snapshot = yield* prepareModuleStateSnapshot(service, 'tenant-1', descriptors);
      expect(observedKeys).toEqual(['billing.invoice', 'inventory.stock']);
      expect(reads).toBe(1);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.entrypointKeys)).toBe(true);
      expect(Object.isFrozen(snapshot.moduleKeys)).toBe(true);
      yield* checkModuleEntrypoint(snapshot, descriptors[0]);
      yield* checkModuleEntrypoint(snapshot, descriptors[0]);
      expect(reads).toBe(1);

      const undeclared = defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'people.directory.page',
        moduleKey: 'people.directory',
        role: 'page',
      });
      const failure = yield* Effect.flip(checkModuleEntrypoint(snapshot, undeclared));
      expect(Predicate.isTagged(failure, 'ModuleStateCheckUnavailableError')).toBe(true);
      const undeclaredSameModule = defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'inventory.stock.undeclared-action',
        moduleKey: 'inventory.stock',
        role: 'action',
      });
      const sameModuleFailure = yield* Effect.flip(
        checkModuleEntrypoint(snapshot, undeclaredSameModule),
      );
      expect(Predicate.isTagged(sameModuleFailure, 'ModuleStateCheckUnavailableError')).toBe(true);
      expect(reads).toBe(1);
    }),
);

it.effect('records safe acquisition and evaluation telemetry including snapshot reuse', () =>
  Effect.gen(function* recordTelemetry() {
    const spans: Tracer.Span[] = [];
    const tracer = makeRecordingTracer(spans);
    const descriptor = defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'inventory.stock.page',
      moduleKey: 'inventory.stock',
      role: 'page',
    });
    const service: TenantModuleStateServiceContract = {
      getTenantModuleStates: () =>
        Effect.succeed([{ moduleKey: 'inventory.stock', state: 'active' }]),
      listActiveTenantModules: () => Effect.succeed([]),
      listTenantModuleStates: () => Effect.succeed([]),
    };

    yield* Effect.gen(function* telemetryEffect() {
      const snapshot = yield* prepareModuleStateSnapshot(service, 'tenant-1', [descriptor]);
      yield* checkModuleEntrypoint(snapshot, descriptor);
      yield* checkModuleEntrypoint(snapshot, descriptor);
      yield* Effect.exit(prepareModuleStateSnapshot(service, '', [descriptor]));
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));

    const acquisitions = spans.filter((span) => span.name === 'ModuleStateGate.acquire');
    const evaluations = spans.filter((span) => span.name === 'ModuleStateGate.evaluate');
    expect(acquisitions.length).toBe(2);
    expect(evaluations.length).toBe(2);
    expect(acquisitions[0]?.attributes.get('batchSize')).toBe(1);
    expect(acquisitions[0]?.attributes.get('outcome')).toBe('available');
    expect(Predicate.isNumber(acquisitions[0]?.attributes.get('elapsedMs'))).toBe(true);
    expect(acquisitions[1]?.attributes.get('outcome')).toBe('unavailable');
    expect(evaluations[0]?.attributes.get('access')).toBe('read');
    expect(evaluations[0]?.attributes.get('outcome')).toBe('allow');
    expect(evaluations[0]?.attributes.get('scope')).toBe('tenant');
    expect(evaluations[0]?.attributes.get('snapshotReuse')).toBe(false);
    expect(evaluations[1]?.attributes.get('snapshotReuse')).toBe(true);

    for (const span of spans) {
      for (const key of span.attributes.keys()) {
        expect(key).not.toMatch(/entrypoint|module|payload|principal|tenant/u);
      }
    }
  }),
);

it.effect('empty and system-only compositions perform zero reads', () =>
  Effect.gen(function* skipEmptyReads() {
    let reads = 0;
    const service: TenantModuleStateServiceContract = {
      getTenantModuleStates: () => {
        reads += 1;
        return Effect.succeed([]);
      },
      listActiveTenantModules: () => Effect.succeed([]),
      listTenantModuleStates: () => Effect.succeed([]),
    };
    const system = defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'core.audit.page',
      moduleKey: 'core.audit',
      role: 'page',
    });
    const empty = yield* prepareModuleStateSnapshot(service, 'tenant-1', []);
    const systemOnly = yield* prepareModuleStateSnapshot(service, 'tenant-1', [system]);
    yield* checkModuleEntrypoint(systemOnly, system);
    expect(empty.moduleKeys).toEqual([]);
    expect(reads).toBe(0);
  }),
);

it.effect('the gateway rejects missing trusted principal context before state acquisition', () =>
  Effect.gen(function* rejectMissingPrincipal() {
    let reads = 0;
    const descriptor = defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'inventory.stock.page',
      moduleKey: 'inventory.stock',
      role: 'page',
    });
    const gate = makeModuleStateGate({
      getTenantModuleStates: () => {
        reads += 1;
        return Effect.succeed([]);
      },
      listActiveTenantModules: () => Effect.succeed([]),
      listTenantModuleStates: () => Effect.succeed([]),
    });
    const failure = yield* Effect.flip(
      makeModuleEntrypointGateway(gate).prepareSnapshotInput({}, [descriptor]),
    );
    expect(Predicate.isTagged(failure, 'ModuleStateCheckUnavailableError')).toBe(true);
    expect(reads).toBe(0);
  }),
);

it.effect('gates every future entrypoint category before its fake implementation load', () =>
  Effect.gen(function* gateEntrypoints() {
    let reads = 0;
    let authorizationCalls = 0;
    let loadCalls = 0;
    const records = [
      { moduleKey: 'module.active', state: 'active' },
      { moduleKey: 'module.archived', state: 'archived' },
      { moduleKey: 'module.deprecated', state: 'deprecated' },
      { moduleKey: 'module.inactive', state: 'inactive' },
      { moduleKey: 'module.read-only', state: 'read_only' },
      { moduleKey: 'module.suspended', state: 'suspended' },
    ] as const;
    const gateway = makeModuleEntrypointGateway(
      makeModuleStateGate({
        getTenantModuleStates: (_tenantId, moduleKeys) => {
          reads += 1;
          return Effect.succeed(records.filter((record) => moduleKeys.includes(record.moduleKey)));
        },
        listActiveTenantModules: () => Effect.succeed([]),
        listTenantModuleStates: () => Effect.succeed([]),
      }),
    );
    const allowed = [
      defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.active.page',
        moduleKey: 'module.active',
        role: 'page',
      }),
      defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.active.component',
        moduleKey: 'module.active',
        role: 'public_component',
      }),
      defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.read-only.api',
        moduleKey: 'module.read-only',
        role: 'api',
      }),
      defineTenantModuleEntrypoint({
        access: 'historical_read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.suspended.api-history',
        moduleKey: 'module.suspended',
        role: 'api',
      }),
      defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.deprecated.search',
        moduleKey: 'module.deprecated',
        role: 'search',
      }),
      defineTenantModuleEntrypoint({
        access: 'historical_read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.inactive.search-history',
        moduleKey: 'module.inactive',
        role: 'search',
      }),
      defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.deprecated.report',
        moduleKey: 'module.deprecated',
        role: 'report',
      }),
      defineTenantModuleEntrypoint({
        access: 'historical_read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.archived.report-history',
        moduleKey: 'module.archived',
        role: 'report',
      }),
      defineSystemModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'core.audit.page',
        moduleKey: 'core.audit',
        role: 'page',
      }),
    ] as const;
    const denied = [
      defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.read-only.api-write',
        moduleKey: 'module.read-only',
        role: 'api',
      }),
      defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.inactive.search',
        moduleKey: 'module.inactive',
        role: 'search',
      }),
      defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.archived.report',
        moduleKey: 'module.archived',
        role: 'report',
      }),
      defineTenantModuleEntrypoint({
        access: 'historical_read',
        authorization: { kind: 'context_permission', permission: 'module.access' },
        entrypointKey: 'module.missing.report-history',
        moduleKey: 'module.missing',
        role: 'report',
      }),
    ] as const;
    const snapshot = yield* gateway.prepareSnapshot(trustedContext(), [...allowed, ...denied]);
    expect(reads).toBe(1);
    expect(snapshot.moduleKeys.includes('core.audit')).toBe(false);
    const run = (entrypoint: (typeof allowed)[number] | (typeof denied)[number]) =>
      gateway.run({
        authorize: Effect.sync(() => {
          authorizationCalls += 1;
        }),
        entrypoint,
        load: Effect.sync(() => {
          loadCalls += 1;
        }),
        snapshot,
      });
    yield* Effect.forEach(allowed, run, { concurrency: 'unbounded' });
    const deniedFailures = yield* Effect.forEach(
      denied,
      (entrypoint) => Effect.flip(run(entrypoint)),
      { concurrency: 'unbounded' },
    );
    for (const failure of deniedFailures) {
      expect(Predicate.isTagged(failure, 'ModuleStateDeniedError')).toBe(true);
    }
    expect(authorizationCalls).toBe(allowed.length);
    expect(loadCalls).toBe(allowed.length);
    expect(reads).toBe(1);
  }),
);

it.effect('the gateway never evaluates authorization or lazy implementation on denial', () =>
  Effect.gen(function* denyBeforeLoading() {
    const gate = makeModuleStateGate({
      getTenantModuleStates: () =>
        Effect.succeed([{ moduleKey: 'inventory.stock', state: 'read_only' }]),
      listActiveTenantModules: () => Effect.succeed([]),
      listTenantModuleStates: () => Effect.succeed([]),
    });
    const gateway = makeModuleEntrypointGateway(gate);
    const descriptor = defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: 'inventory.stock.reserve',
      moduleKey: 'inventory.stock',
      role: 'action',
    });
    const snapshot = yield* gateway.prepareSnapshot(trustedContext(), [descriptor]);
    let authorizationCalls = 0;
    let loadFactoryCalls = 0;
    let loadCalls = 0;
    const failure = yield* Effect.flip(
      gateway.run({
        authorize: Effect.sync(() => {
          authorizationCalls += 1;
        }),
        entrypoint: descriptor,
        load: Effect.suspend(() => {
          loadFactoryCalls += 1;
          return Effect.sync(() => {
            loadCalls += 1;
            return 'loaded';
          });
        }),
        snapshot,
      }),
    );
    expect(Predicate.isTagged(failure, 'ModuleStateDeniedError')).toBe(true);
    expect(authorizationCalls).toBe(0);
    expect(loadFactoryCalls).toBe(0);
    expect(loadCalls).toBe(0);
  }),
);

it.effect('a missing row is a definite denial rather than an unavailable read', () =>
  Effect.gen(function* denyMissingRow() {
    const descriptor = defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'inventory.stock.page',
      moduleKey: 'inventory.stock',
      role: 'page',
    });
    const snapshot = makeModuleStateSnapshot('tenant-1', [descriptor], []);
    const failure = yield* Effect.flip(checkModuleEntrypoint(snapshot, descriptor));
    expect(Predicate.isTagged(failure, 'ModuleStateDeniedError')).toBe(true);
  }),
);
