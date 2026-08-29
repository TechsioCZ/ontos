// @effect-diagnostics asyncFunction:off lazyEffect:off
import assert from 'node:assert/strict';
import test from 'node:test';
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

void test('encodes the exhaustive state/access matrix once, including missing state', () => {
  for (const state of TENANT_MODULE_STATES) {
    for (const access of MODULE_ENTRYPOINT_ACCESSES) {
      assert.equal(
        decideModuleStateAccess(state, access),
        expectedAllowed[state].has(access) ? 'allow' : 'deny',
        `${state}/${access}`,
      );
    }
  }
  for (const access of MODULE_ENTRYPOINT_ACCESSES) {
    assert.equal(decideModuleStateAccess(null, access), 'deny');
    assert.deepEqual(
      tenantStatesAllowingAccess(access),
      TENANT_MODULE_STATES.filter((state) => expectedAllowed[state].has(access)).toSorted(),
    );
  }
});

void test('constructs frozen tenant and explicit system entrypoints and rejects forged combinations', () => {
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
  assert.equal(Object.isFrozen(tenant), true);
  assert.equal(tenant.scope, 'tenant');
  assert.equal(system.scope, 'system');
  assert.throws(() =>
    decodeTenantModuleEntrypoint({
      access: 'read',
      entrypointKey: 'inventory.stock.reserve',
      moduleKey: 'inventory.stock',
      role: 'action',
    }),
  );
  assert.throws(() =>
    defineSystemModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: 'Invalid',
      moduleKey: 'inventory.stock',
      role: 'action',
    }),
  );
  for (const [role, access] of [
    ['page', 'read'],
    ['public_component', 'historical_read'],
    ['api', 'write'],
    ['search', 'historical_read'],
    ['report', 'read'],
    ['worker', 'background'],
  ] as const) {
    assert.equal(
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
      role,
    );
  }
});

void test('deduplicates one batch, reuses an immutable snapshot, and fails undeclared keys closed', async () => {
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
  const snapshot = await Effect.runPromise(
    prepareModuleStateSnapshot(service, 'tenant-1', descriptors),
  );
  assert.deepEqual(observedKeys, ['billing.invoice', 'inventory.stock']);
  assert.equal(reads, 1);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.entrypointKeys), true);
  assert.equal(Object.isFrozen(snapshot.moduleKeys), true);
  await Effect.runPromise(checkModuleEntrypoint(snapshot, descriptors[0]));
  await Effect.runPromise(checkModuleEntrypoint(snapshot, descriptors[0]));
  assert.equal(reads, 1);

  const undeclared = defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'people.directory.page',
    moduleKey: 'people.directory',
    role: 'page',
  });
  const failure = await Effect.runPromise(Effect.flip(checkModuleEntrypoint(snapshot, undeclared)));
  assert.equal(failure._tag, 'ModuleStateCheckUnavailableError');
  const undeclaredSameModule = defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: 'inventory.stock.undeclared-action',
    moduleKey: 'inventory.stock',
    role: 'action',
  });
  const sameModuleFailure = await Effect.runPromise(
    Effect.flip(checkModuleEntrypoint(snapshot, undeclaredSameModule)),
  );
  assert.equal(sameModuleFailure._tag, 'ModuleStateCheckUnavailableError');
  assert.equal(reads, 1);
});

void test('records safe acquisition and evaluation telemetry including snapshot reuse', async () => {
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

  await Effect.runPromise(
    Effect.gen(function* telemetryEffect() {
      const snapshot = yield* prepareModuleStateSnapshot(service, 'tenant-1', [descriptor]);
      yield* checkModuleEntrypoint(snapshot, descriptor);
      yield* checkModuleEntrypoint(snapshot, descriptor);
      yield* Effect.exit(prepareModuleStateSnapshot(service, '', [descriptor]));
    }).pipe(Effect.provideService(Tracer.Tracer, tracer)),
  );

  const acquisitions = spans.filter((span) => span.name === 'ModuleStateGate.acquire');
  const evaluations = spans.filter((span) => span.name === 'ModuleStateGate.evaluate');
  assert.equal(acquisitions.length, 2);
  assert.equal(evaluations.length, 2);
  assert.equal(acquisitions[0]?.attributes.get('batchSize'), 1);
  assert.equal(acquisitions[0]?.attributes.get('outcome'), 'available');
  assert.equal(Predicate.isNumber(acquisitions[0]?.attributes.get('elapsedMs')), true);
  assert.equal(acquisitions[1]?.attributes.get('outcome'), 'unavailable');
  assert.equal(evaluations[0]?.attributes.get('access'), 'read');
  assert.equal(evaluations[0]?.attributes.get('outcome'), 'allow');
  assert.equal(evaluations[0]?.attributes.get('scope'), 'tenant');
  assert.equal(evaluations[0]?.attributes.get('snapshotReuse'), false);
  assert.equal(evaluations[1]?.attributes.get('snapshotReuse'), true);

  for (const span of spans) {
    for (const key of span.attributes.keys()) {
      assert.doesNotMatch(key, /entrypoint|module|payload|principal|tenant/u);
    }
  }
});

void test('empty and system-only compositions perform zero reads', async () => {
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
  const empty = await Effect.runPromise(prepareModuleStateSnapshot(service, 'tenant-1', []));
  const systemOnly = await Effect.runPromise(
    prepareModuleStateSnapshot(service, 'tenant-1', [system]),
  );
  await Effect.runPromise(checkModuleEntrypoint(systemOnly, system));
  assert.deepEqual(empty.moduleKeys, []);
  assert.equal(reads, 0);
});

void test('the gateway rejects missing trusted principal context before state acquisition', async () => {
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
  const failure = await Effect.runPromise(
    Effect.flip(makeModuleEntrypointGateway(gate).prepareSnapshotInput({}, [descriptor])),
  );
  assert.equal(failure._tag, 'ModuleStateCheckUnavailableError');
  assert.equal(reads, 0);
});

void test('gates every future entrypoint category before its fake implementation load', async () => {
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
  const snapshot = await Effect.runPromise(
    gateway.prepareSnapshot(trustedContext(), [...allowed, ...denied]),
  );
  assert.equal(reads, 1);
  assert.equal(snapshot.moduleKeys.includes('core.audit'), false);
  const run = (entrypoint: (typeof allowed)[number] | (typeof denied)[number]) =>
    gateway.run({
      authorize: Effect.sync(() => {
        authorizationCalls += 1;
      }),
      entrypoint,
      load: () =>
        Effect.sync(() => {
          loadCalls += 1;
        }),
      snapshot,
    });
  await Promise.all(allowed.map(async (entrypoint) => await Effect.runPromise(run(entrypoint))));
  const deniedFailures = await Promise.all(
    denied.map(async (entrypoint) => await Effect.runPromise(Effect.flip(run(entrypoint)))),
  );
  for (const failure of deniedFailures) {
    assert.equal(failure._tag, 'ModuleStateDeniedError');
  }
  assert.equal(authorizationCalls, allowed.length);
  assert.equal(loadCalls, allowed.length);
  assert.equal(reads, 1);
});

void test('the gateway never evaluates authorization or lazy implementation on denial', async () => {
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
  const snapshot = await Effect.runPromise(gateway.prepareSnapshot(trustedContext(), [descriptor]));
  let authorizationCalls = 0;
  let loadFactoryCalls = 0;
  let loadCalls = 0;
  const failure = await Effect.runPromise(
    Effect.flip(
      gateway.run({
        authorize: Effect.sync(() => {
          authorizationCalls += 1;
        }),
        entrypoint: descriptor,
        load: () => {
          loadFactoryCalls += 1;
          return Effect.sync(() => {
            loadCalls += 1;
            return 'loaded';
          });
        },
        snapshot,
      }),
    ),
  );
  assert.equal(failure._tag, 'ModuleStateDeniedError');
  assert.equal(authorizationCalls, 0);
  assert.equal(loadFactoryCalls, 0);
  assert.equal(loadCalls, 0);
});

void test('a missing row is a definite denial rather than an unavailable read', async () => {
  const descriptor = defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'context_permission', permission: 'module.access' },
    entrypointKey: 'inventory.stock.page',
    moduleKey: 'inventory.stock',
    role: 'page',
  });
  const snapshot = makeModuleStateSnapshot('tenant-1', [descriptor], []);
  const failure = await Effect.runPromise(Effect.flip(checkModuleEntrypoint(snapshot, descriptor)));
  assert.equal(failure._tag, 'ModuleStateDeniedError');
});
