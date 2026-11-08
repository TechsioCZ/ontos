import {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
  TrustedPrincipalContextSchema,
  defineTenantModuleEntrypoint,
} from '@app/core-runtime';
import type {
  ModuleEntrypointDescriptor,
  ModuleEntrypointGatewayService,
  ModuleStateGateError,
  ModuleStateSnapshot,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { Clock, Effect, Fiber, Function as Fn, Match, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  loadModuleEntrypointComposition,
  makeModuleEntrypointLoadScheduler,
  moduleEntrypointLoadIdentity,
  MODULE_LOAD_CONCURRENCY,
  ModuleEntrypointNamespaceSchema,
  settleModuleEntrypointLoads,
} from '../../src/routes/module-entrypoint-loader.ts';
import type {
  ModuleEntrypointLoadFailure,
  ModuleEntrypointNamespace,
} from '../../src/routes/module-entrypoint-loader.ts';
import { ResolvedModuleTargetSchema } from '../../shared/api.ts';

const remoteDefault = () => null;

const trustedContext: TrustedPrincipalContext = {
  authMethod: 'session',
  principalId: '10000000-0000-4000-8000-000000000001',
  tenantId: '20000000-0000-4000-8000-000000000001',
};

interface FakeGatewayOptions {
  readonly deniedEntrypointKeys?: ReadonlySet<string>;
  readonly onPrepare?: (entrypoints: readonly ModuleEntrypointDescriptor[]) => void;
  readonly unavailable?: boolean;
}

const makeFakeGateway = (options: FakeGatewayOptions = {}): ModuleEntrypointGatewayService => {
  const check: ModuleEntrypointGatewayService['check'] = (snapshot, entrypoint) => {
    if (!snapshot.entrypointKeys.includes(entrypoint.entrypointKey)) {
      return Effect.fail(
        new ModuleStateCheckUnavailableError({
          code: 'module_state_check_unavailable',
          reason: 'Module state could not be checked safely',
        }),
      );
    }
    return options.deniedEntrypointKeys?.has(entrypoint.entrypointKey) === true
      ? Effect.fail(
          new ModuleStateDeniedError({
            code: 'module_state_denied',
            reason: 'The module entrypoint is unavailable in the current module state',
          }),
        )
      : Effect.void;
  };
  const prepareSnapshot: ModuleEntrypointGatewayService['prepareSnapshot'] = (context, entrypoints) => {
    options.onPrepare?.(entrypoints);
    if (options.unavailable === true || context.tenantId.length === 0) {
      return Effect.fail(
        new ModuleStateCheckUnavailableError({
          code: 'module_state_check_unavailable',
          reason: 'Module state could not be checked safely',
        }),
      );
    }
    const snapshot: ModuleStateSnapshot = Object.freeze({
      entrypointKeys: Object.freeze(entrypoints.map(({ entrypointKey }) => entrypointKey)),
      moduleKeys: Object.freeze([...new Set(entrypoints.map(({ moduleKey }) => moduleKey))].toSorted()),
      tenantId: context.tenantId,
    });
    return Effect.succeed(snapshot);
  };
  const gateway: ModuleEntrypointGatewayService = {
    check,
    prepareSnapshot,
    prepareSnapshotInput: (context, entrypoints) =>
      Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(context).pipe(
        Effect.mapError(
          () =>
            new ModuleStateCheckUnavailableError({
              code: 'module_state_check_unavailable',
              reason: 'Module state could not be checked safely',
            }),
        ),
        Effect.flatMap((trusted) => prepareSnapshot(trusted, entrypoints)),
      ),
    run: (input) =>
      check(input.snapshot, input.entrypoint).pipe(Effect.andThen(input.authorize), Effect.andThen(input.load)),
  };
  return gateway;
};

const page = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'inventory.stock.page.orders',
  moduleKey: 'inventory.stock',
  role: 'page',
});
const component = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'inventory.stock.component.summary',
  moduleKey: 'inventory.stock',
  role: 'public_component',
});

const RemoteModuleSchema = Schema.Struct({
  default: Schema.declare<() => null>((value): value is () => null => Predicate.isFunction(value)),
});

const startedNamespaceLoad =
  (start: Effect.Effect<void>, namespace: Effect.Effect<ModuleEntrypointNamespace, ModuleEntrypointLoadFailure>) =>
  () =>
    start.pipe(Effect.andThen(namespace));

const remoteTarget = (owner: string, expose = 'page') =>
  Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    appId: owner,
    componentKey: expose,
    compositionRevision: 'a'.repeat(64),
    entrypointKey: `${owner}.page.${expose}`,
    federation: {
      expose,
      manifest: { sha256: 'b'.repeat(64), url: `https://${owner}.example/immutable-mf.json` },
      remoteName: owner,
    },
    moduleId: `${owner}.module`,
    routeParameters: {},
    writable: false,
  });
const loadIdentity = (owner: string, expose = 'page') => moduleEntrypointLoadIdentity(remoteTarget(owner, expose));

it.effect('prepares one complete trusted composition and invokes allowed lazy loaders', () =>
  Effect.gen(function* verifyCompleteComposition() {
    let batches = 0;
    let loads = 0;
    const gateway = makeFakeGateway({
      onPrepare: (entrypoints) => {
        batches += 1;
        expect(entrypoints).toEqual([page, component]);
      },
    });
    const result = yield* loadModuleEntrypointComposition(
      gateway,
      trustedContext,
      [page, component].map((entrypoint) => ({
        authorize: Effect.void,
        entrypoint,
        load: Effect.sync(() => {
          loads += 1;
          return `loaded-${loads}`;
        }),
      })),
    );
    expect(result).toEqual(['loaded-1', 'loaded-2']);
    expect(batches).toBe(1);
  }),
);

it.effect('checks the complete composition before authorizing or invoking any loader', () =>
  Effect.gen(function* verifyDeniedComposition() {
    let authorizations = 0;
    let loads = 0;
    const gateway = makeFakeGateway({
      deniedEntrypointKeys: new Set([component.entrypointKey]),
    });
    const error = yield* Effect.flip(
      loadModuleEntrypointComposition(
        gateway,
        trustedContext,
        [page, component].map((entrypoint) => ({
          authorize: Effect.sync(() => {
            authorizations += 1;
          }),
          entrypoint,
          load: Effect.sync(() => {
            loads += 1;
            return loads;
          }),
        })),
      ),
    );
    expect(Schema.is(ModuleStateDeniedError)(error)).toBe(true);
    expect(authorizations).toBe(0);
    expect(loads).toBe(0);
  }),
);

class RemoteLoadUnavailable extends Schema.TaggedError<RemoteLoadUnavailable>()('RemoteLoadUnavailable', {}) {}
const FakeUnavailableUiStateSchema = Schema.Literals(['forbidden', 'unavailable']);
type FakeUnavailableUiState = typeof FakeUnavailableUiStateSchema.Type;

const mapFakeUnavailableUiState = (error: ModuleStateGateError | RemoteLoadUnavailable): FakeUnavailableUiState =>
  Match.value(error).pipe(
    Match.tag('ModuleStateDeniedError', () => 'forbidden' as const),
    Match.tag('ModuleStateCheckUnavailableError', 'RemoteLoadUnavailable', () => 'unavailable' as const),
    Match.exhaustive,
  );

it.effect('preserves typed gate and remote-load failures for exhaustive UI mapping', () =>
  Effect.gen(function* verifyTypedFailures() {
    const gateFailure = yield* Effect.flip(
      loadModuleEntrypointComposition(makeFakeGateway({ unavailable: true }), trustedContext, [
        {
          authorize: Effect.void,
          entrypoint: page,
          load: Effect.succeed('unreachable'),
        },
      ]),
    );
    expect(mapFakeUnavailableUiState(gateFailure)).toBe('unavailable');

    const remoteFailure = yield* Effect.flip(
      loadModuleEntrypointComposition(makeFakeGateway(), trustedContext, [
        {
          authorize: Effect.void,
          entrypoint: page,
          load: Effect.fail(new RemoteLoadUnavailable()),
        },
      ]),
    );
    expect(remoteFailure).toEqual(new RemoteLoadUnavailable());
    expect(mapFakeUnavailableUiState(remoteFailure)).toBe('unavailable');
  }),
);

it.effect('settles browser entrypoint success, rejection, incompatibility, and timeout independently', () =>
  Effect.gen(function* verifySettledLoads() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const pending = Promise.withResolvers<RemoteModule>();
    const loadStarted = Promise.withResolvers<null>();
    const resultsFiber = yield* scheduler
      .settle([
        {
          contract: RemoteModuleSchema,
          identity: 'ready',
          load: () =>
            Effect.tryPromise(() => Promise.resolve({ default: remoteDefault })).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
            ),
          loadIdentity: loadIdentity('standalone-ready'),
          timeoutMs: 50,
        },
        {
          contract: RemoteModuleSchema,
          identity: 'rejected',
          load: () =>
            Effect.tryPromise(() => Promise.reject(new Error('remote unavailable'))).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
            ),
          loadIdentity: loadIdentity('standalone-rejected'),
          timeoutMs: 50,
        },
        {
          contract: RemoteModuleSchema,
          identity: 'incompatible',
          load: () =>
            Effect.tryPromise(() => Promise.resolve({ default: 'not a component' })).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
            ),
          loadIdentity: loadIdentity('standalone-incompatible'),
          timeoutMs: 50,
        },
        {
          contract: RemoteModuleSchema,
          identity: 'timed-out',
          load: () =>
            Effect.tryPromise(() => {
              loadStarted.resolve(null);
              return pending.promise;
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
          loadIdentity: loadIdentity('standalone-timeout'),
          timeoutMs: 1,
        },
      ])
      .pipe(Effect.ensuring(Effect.sync(() => pending.resolve({ default: remoteDefault }))), Effect.forkChild);
    yield* Effect.promise(() => loadStarted.promise);
    yield* TestClock.adjust('1 millis');
    const results = yield* Fiber.join(resultsFiber);
    expect(results).toEqual([
      { identity: 'ready', state: 'ready', value: { default: remoteDefault } },
      { identity: 'rejected', reason: 'unavailable', state: 'unavailable' },
      { identity: 'incompatible', reason: 'incompatible', state: 'unavailable' },
      { identity: 'timed-out', reason: 'timeout', state: 'unavailable' },
    ]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect('settles several browser entrypoints without one failure hiding healthy loads', () =>
  Effect.gen(function* verifySettledLoadCollection() {
    const results = yield* settleModuleEntrypointLoads([
      {
        contract: RemoteModuleSchema,
        identity: 'documents-center/page',
        load: () =>
          Effect.tryPromise(() => Promise.resolve({ default: remoteDefault })).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
          ),
        loadIdentity: loadIdentity('documents-center'),
        timeoutMs: 50,
      },
      {
        contract: RemoteModuleSchema,
        identity: 'property-registry/page',
        load: () =>
          Effect.tryPromise(() => Promise.reject(new Error('remote unavailable'))).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
          ),

        loadIdentity: loadIdentity('property-registry'),
        timeoutMs: 50,
      },
      {
        contract: RemoteModuleSchema,
        identity: 'malformed-module/page',
        load: () =>
          Effect.tryPromise(() => Promise.resolve({ default: 'malformed' })).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
          ),
        loadIdentity: loadIdentity('malformed-module'),
        timeoutMs: 50,
      },
    ]);

    expect(results).toEqual([
      {
        identity: 'documents-center/page',
        state: 'ready',
        value: expect.objectContaining({ default: expect.any(Function) }),
      },
      {
        identity: 'property-registry/page',
        reason: 'unavailable',
        state: 'unavailable',
      },
      {
        identity: 'malformed-module/page',
        reason: 'incompatible',
        state: 'unavailable',
      },
    ]);
  }),
);

type RemoteModule = typeof RemoteModuleSchema.Type;

it.live('never starts a queued load whose deadline expired before a permit became available', () =>
  Effect.gen(function* verifyCase1() {
    const pendingLoads: PromiseWithResolvers<RemoteModule>[] = [];
    const firstWindowStarted = Promise.withResolvers<null>();
    let loadCount = 0;
    const resultsFiber = yield* Effect.forkChild(
      settleModuleEntrypointLoads(
        Array.from({ length: MODULE_LOAD_CONCURRENCY + 1 }, (_, index) => ({
          contract: RemoteModuleSchema,
          identity: `module-${index}/page`,
          load: () =>
            Effect.tryPromise(() => {
              const pending = Promise.withResolvers<RemoteModule>();
              pendingLoads.push(pending);
              loadCount += 1;
              if (loadCount === MODULE_LOAD_CONCURRENCY) {
                firstWindowStarted.resolve(null);
              }
              return Promise.resolve(pending.promise);
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),

          loadIdentity: loadIdentity(`module-${index}`),
          // The first window must outlive runner jitter so every slot is really held; only the
          // queued load carries the short deadline that expires before any permit frees up.
          timeoutMs: index < MODULE_LOAD_CONCURRENCY ? 500 : 10,
        })),
      ),
    );

    yield* Effect.promise(() => firstWindowStarted.promise);
    expect(loadCount).toBe(MODULE_LOAD_CONCURRENCY);
    expect(pendingLoads).toHaveLength(MODULE_LOAD_CONCURRENCY);

    const results = yield* Fiber.join(resultsFiber);
    expect(results).toEqual(
      Array.from({ length: MODULE_LOAD_CONCURRENCY + 1 }, (_, index) => ({
        identity: `module-${index}/page`,
        reason: 'timeout',
        state: 'unavailable',
      })),
    );
    expect(loadCount).toBe(MODULE_LOAD_CONCURRENCY);

    for (const pending of pendingLoads) {
      pending.resolve({ default: () => null });
    }
    yield* Effect.all(
      pendingLoads.map(({ promise }) =>
        Effect.gen(function* verifyCase2() {
          return yield* Effect.promise(() => promise);
        }),
      ),
      { concurrency: 'unbounded' },
    );
    yield* Effect.yieldNow;
    expect(loadCount).toBe(MODULE_LOAD_CONCURRENCY);
  }),
);

it.live('never starts an expired queued load when synchronous work delays deadline timers', () =>
  Effect.gen(function* verifyCase3() {
    const started: number[] = [];
    // Use the live clock: TestClock would not advance while the JavaScript thread is blocked.
    const clock = yield* Clock.Clock;
    const results = yield* settleModuleEntrypointLoads(
      Array.from({ length: MODULE_LOAD_CONCURRENCY + 1 }, (_, index) => ({
        contract: RemoteModuleSchema,
        identity: `module-${index}/page`,
        load: () =>
          Effect.tryPromise(() => {
            started.push(index);
            if (index === 0) {
              const unblockAt = clock.currentTimeMillisUnsafe() + 40;
              // Busy-wait past the queued deadline without letting its timer callback run.
              while (clock.currentTimeMillisUnsafe() < unblockAt) {
                // Intentionally keep the event loop blocked.
              }
            }
            return Promise.resolve({ default: remoteDefault });
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),

        loadIdentity: loadIdentity(`module-${index}`),
        timeoutMs: index === MODULE_LOAD_CONCURRENCY ? 10 : 5000,
      })),
    );

    expect(started).toContain(0);
    expect(started).not.toContain(MODULE_LOAD_CONCURRENCY);
    expect(results[MODULE_LOAD_CONCURRENCY]).toEqual({
      identity: `module-${MODULE_LOAD_CONCURRENCY}/page`,
      reason: 'timeout',
      state: 'unavailable',
    });
  }),
);

it.effect('abandons queued loads when the caller is interrupted', () =>
  Effect.gen(function* verifyInterruptedCaller() {
    const pendingLoads = Array.from({ length: MODULE_LOAD_CONCURRENCY }, () => Promise.withResolvers<RemoteModule>());
    const firstWindowStarted = Promise.withResolvers<null>();
    const started: number[] = [];
    const caller = yield* Effect.forkChild(
      settleModuleEntrypointLoads(
        Array.from({ length: 12 }, (_, index) => ({
          contract: RemoteModuleSchema,
          identity: `module-${index}/page`,
          load: () =>
            Effect.tryPromise(() => {
              started.push(index);
              if (started.length === MODULE_LOAD_CONCURRENCY) {
                firstWindowStarted.resolve(null);
              }
              return pendingLoads[index]?.promise ?? Promise.resolve({ default: remoteDefault });
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),

          loadIdentity: loadIdentity(`module-${index}`),
        })),
      ),
    );

    yield* Effect.promise(() => firstWindowStarted.promise);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    yield* Fiber.interrupt(caller);
    for (const pending of pendingLoads) {
      pending.resolve({ default: () => null });
    }
    yield* Effect.promise(() => Promise.all(pendingLoads.map(({ promise }) => promise)));
    yield* TestClock.adjust('1 millis');
    expect(started).toHaveLength(8);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect('holds a running timed-out load permit until settlement then releases it to a live queued load', () =>
  Effect.gen(function* verifyPermitRelease() {
    const pendingLoads = Array.from({ length: MODULE_LOAD_CONCURRENCY }, () => Promise.withResolvers<RemoteModule>());
    const firstWindowStarted = Promise.withResolvers<null>();
    const queuedLoadStarted = Promise.withResolvers<null>();
    const events: string[] = [];
    const resultsFiber = yield* Effect.forkChild(
      settleModuleEntrypointLoads(
        Array.from({ length: MODULE_LOAD_CONCURRENCY + 1 }, (_, index) => ({
          contract: RemoteModuleSchema,
          identity: `module-${index}/page`,
          load: () =>
            Effect.tryPromise(() => {
              events.push(`started-${index}`);
              if (index === MODULE_LOAD_CONCURRENCY - 1) {
                firstWindowStarted.resolve(null);
              }
              const pending = pendingLoads[index];
              if (pending === undefined) {
                queuedLoadStarted.resolve(null);
                return Promise.resolve({ default: remoteDefault });
              }
              return pending.promise;
            }).pipe(
              Effect.tap(
                Effect.sync(() => {
                  if (pendingLoads[index] !== undefined) {
                    events.push(`settled-${index}`);
                  }
                }),
              ),
              Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
            ),

          loadIdentity: loadIdentity(`module-${index}`),
          timeoutMs: index === 0 ? 10 : 1000,
        })),
      ),
    );

    yield* Effect.promise(() => firstWindowStarted.promise);
    yield* TestClock.adjust('20 millis');
    expect(events).toEqual(Array.from({ length: MODULE_LOAD_CONCURRENCY }, (_, index) => `started-${index}`));

    pendingLoads[0]?.resolve({ default: () => null });
    yield* Effect.promise(() => queuedLoadStarted.promise);
    expect(events.slice(-2)).toEqual(['settled-0', `started-${MODULE_LOAD_CONCURRENCY}`]);
    for (const pending of pendingLoads) {
      pending.resolve({ default: () => null });
    }
    const results = yield* Fiber.join(resultsFiber);
    expect(results[0]).toEqual({
      identity: 'module-0/page',
      reason: 'timeout',
      state: 'unavailable',
    });
    expect(results.slice(1).every(({ state }) => state === 'ready')).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect('does not surface a late remote rejection after a timeout', () =>
  Effect.gen(function* verifyLateRemoteRejection() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const pending = Promise.withResolvers<RemoteModule>();
    const loadStarted = Promise.withResolvers<null>();
    const loadSettled = Promise.withResolvers<null>();
    let starts = 0;
    const resultFiber = yield* Effect.forkChild(
      scheduler.settle([
        {
          contract: RemoteModuleSchema,
          identity: 'late-rejection/page',
          load: () =>
            Effect.tryPromise(() => {
              starts += 1;
              loadStarted.resolve(null);
              return Promise.resolve(
                pending.promise.finally(() => {
                  loadSettled.resolve(null);
                }),
              );
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),

          loadIdentity: loadIdentity('late-rejection'),
          timeoutMs: 10,
        },
      ]),
    );
    yield* Effect.promise(() => loadStarted.promise);
    yield* TestClock.adjust('10 millis');
    const result = yield* Fiber.join(resultFiber);
    expect(result).toEqual([
      {
        identity: 'late-rejection/page',
        reason: 'timeout',
        state: 'unavailable',
      },
    ]);
    pending.reject(new Error('remote unavailable'));
    yield* Effect.promise(() => loadSettled.promise);
    yield* TestClock.adjust('0 millis');
    expect(result).toEqual([
      {
        identity: 'late-rejection/page',
        reason: 'timeout',
        state: 'unavailable',
      },
    ]);
    const retried = yield* scheduler.settle([
      {
        contract: RemoteModuleSchema,
        identity: 'late-rejection/retry',
        load: () =>
          Effect.tryPromise(() => {
            starts += 1;
            return Promise.resolve({ default: remoteDefault });
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
        loadIdentity: loadIdentity('late-rejection'),
      },
    ]);
    expect(retried[0]?.state).toBe('ready');
    expect(starts).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect('shares load permits across separate navigations until uncancellable imports settle', () =>
  Effect.gen(function* boundsLoadsAcrossNavigations() {
    const pending = Array.from({ length: MODULE_LOAD_CONCURRENCY }, () => Promise.withResolvers<RemoteModule>());
    const firstWindowStarted = Promise.withResolvers<null>();
    let started = 0;
    const makeRequest = (index: number, timeoutMs: number) => ({
      contract: RemoteModuleSchema,
      identity: `navigation-${index}/page`,
      load: () =>
        Effect.tryPromise(() => {
          started += 1;
          if (started === MODULE_LOAD_CONCURRENCY) {
            firstWindowStarted.resolve(null);
          }
          return pending[index]?.promise ?? Promise.resolve({ default: remoteDefault });
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
      loadIdentity: loadIdentity(`navigation-${index}`),
      timeoutMs,
    });
    yield* Effect.gen(function* verifyGlobalPermits() {
      const navigations = yield* Effect.forEach(
        pending,
        (_, index) => Effect.forkChild(settleModuleEntrypointLoads([makeRequest(index, 10)])),
        { concurrency: 1 },
      );
      yield* Effect.promise(() => firstWindowStarted.promise);
      yield* TestClock.adjust('10 millis');
      const timedOut = yield* Effect.forEach(navigations, (navigation) => Fiber.join(navigation), { concurrency: 1 });
      expect(timedOut.every(([result]) => result?.state === 'unavailable' && result.reason === 'timeout')).toBe(true);

      const anotherNavigation = yield* Effect.forkChild(
        settleModuleEntrypointLoads([makeRequest(MODULE_LOAD_CONCURRENCY, 10)]),
      );
      yield* TestClock.adjust('10 millis');
      expect(yield* Fiber.join(anotherNavigation)).toEqual([
        {
          identity: `navigation-${MODULE_LOAD_CONCURRENCY}/page`,
          reason: 'timeout',
          state: 'unavailable',
        },
      ]);
      expect(started).toBe(MODULE_LOAD_CONCURRENCY);

      for (const remote of pending) {
        remote.resolve({ default: remoteDefault });
      }
      yield* Effect.promise(() => Promise.all(pending.map(({ promise }) => promise)));
      const healthyNavigation = yield* settleModuleEntrypointLoads([makeRequest(MODULE_LOAD_CONCURRENCY + 1, 100)]);
      expect(healthyNavigation[0]?.state).toBe('ready');
      expect(started).toBe(MODULE_LOAD_CONCURRENCY + 1);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const remote of pending) {
            remote.resolve({ default: remoteDefault });
          }
        }),
      ),
    );
  }).pipe(Effect.provide(TestClock.layer())),
);

it('separates exact owner artifact and exposed result identities', () => {
  const target = remoteTarget('identity-owner', 'x');
  const identity = moduleEntrypointLoadIdentity(target);
  expect(identity).toEqual({
    artifact:
      '["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","identity-owner","identity-owner.module","identity-owner","https://identity-owner.example/immutable-mf.json","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]',
    owner: '["identity-owner","identity-owner.module"]',
    result:
      '["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","identity-owner","identity-owner.module","identity-owner","https://identity-owner.example/immutable-mf.json","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","x","x","identity-owner.page.x"]',
  });
  expect(Object.isFrozen(identity)).toBe(true);
  for (const changed of [
    { ...target, compositionRevision: 'c'.repeat(64) },
    { ...target, appId: 'other-owner' },
    { ...target, moduleId: 'other-owner.module' },
    { ...target, federation: { ...target.federation, remoteName: 'other-remote' } },
    {
      ...target,
      federation: {
        ...target.federation,
        manifest: { ...target.federation.manifest, url: 'https://other.example/immutable-mf.json' },
      },
    },
    {
      ...target,
      federation: { ...target.federation, manifest: { ...target.federation.manifest, sha256: 'd'.repeat(64) } },
    },
  ]) {
    const decoded = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)(changed);
    const next = moduleEntrypointLoadIdentity(decoded);
    expect(next.artifact).not.toBe(identity.artifact);
    expect(next.result).not.toBe(identity.result);
  }
  for (const changed of [
    { ...target, componentKey: 'y' },
    { ...target, entrypointKey: 'identity-owner.page.y' },
    { ...target, federation: { ...target.federation, expose: 'y' } },
  ]) {
    const next = moduleEntrypointLoadIdentity(Schema.decodeUnknownSync(ResolvedModuleTargetSchema)(changed));
    expect(next.owner).toBe(identity.owner);
    expect(next.artifact).toBe(identity.artifact);
    expect(next.result).not.toBe(identity.result);
  }
});

it.effect('deduplicates eleven stalled A waits while healthy B starts without waiting for A', () =>
  Effect.gen(function* sharesPhysicalWorkWithoutStarvingHealthyOwner() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const pending = Promise.withResolvers<RemoteModule>();
    const started = Promise.withResolvers<null>();
    let aStarts = 0;
    let current = 0;
    let maximum = 0;
    const a = yield* scheduler
      .settle(
        Array.from({ length: 11 }, (_, index) => ({
          contract: RemoteModuleSchema,
          identity: index,
          load: () =>
            Effect.tryPromise(() => {
              aStarts += 1;
              current += 1;
              maximum = Math.max(maximum, current);
              started.resolve(null);
              return pending.promise;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  current -= 1;
                }),
              ),
              Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
            ),
          loadIdentity: loadIdentity('stalled-owner'),
          timeoutMs: 10,
        })),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    const before = yield* Clock.currentTimeMillis;
    const healthy = yield* scheduler.settle([
      {
        contract: RemoteModuleSchema,
        identity: 'healthy',
        load: () =>
          Effect.tryPromise(() => {
            current += 1;
            maximum = Math.max(maximum, current);
            return Promise.resolve({ default: remoteDefault }).finally(() => {
              current -= 1;
            });
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
        loadIdentity: loadIdentity('healthy-owner'),
      },
    ]);
    const waited = (yield* Clock.currentTimeMillis) - before;
    expect(healthy[0]?.state).toBe('ready');
    expect(waited).toBe(0);
    expect(aStarts).toBe(1);
    expect(maximum).toBe(2);
    expect(current).toBe(1);
    yield* TestClock.adjust('10 millis');
    expect(
      (yield* Fiber.join(a)).every((result) => result.state === 'unavailable' && result.reason === 'timeout'),
    ).toBe(true);
    expect(current).toBe(1);
    pending.resolve({ default: remoteDefault });
    yield* Effect.promise(() => pending.promise);
  }),
);

it.effect('keeps two exposes of one artifact as distinct validated raw results', () =>
  Effect.gen(function* separatesExposedExports() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const x = { default: Fn.constant(null) };
    const y = { default: Fn.constant(null) };
    let starts = 0;
    const results = yield* scheduler.settle([
      {
        contract: RemoteModuleSchema,
        identity: 'x',
        load: () =>
          Effect.tryPromise(() => {
            starts += 1;
            return Promise.resolve(x);
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
        loadIdentity: loadIdentity('same-remote', 'x'),
      },
      {
        contract: RemoteModuleSchema,
        identity: 'y',
        load: () =>
          Effect.tryPromise(() => {
            starts += 1;
            return Promise.resolve(y);
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
        loadIdentity: loadIdentity('same-remote', 'y'),
      },
    ]);
    expect(results).toEqual([
      { identity: 'x', state: 'ready', value: x },
      { identity: 'y', state: 'ready', value: y },
    ]);
    expect(starts).toBe(2);
  }),
);

it.effect('keeps caller deadlines independent while shared physical work later succeeds', () =>
  Effect.gen(function* sharesRawResultWithIndependentDeadlines() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const pending = Promise.withResolvers<RemoteModule>();
    const started = Promise.withResolvers<null>();
    let starts = 0;
    const load = startedNamespaceLoad(
      Effect.sync(() => {
        starts += 1;
        started.resolve(null);
      }),
      Effect.tryPromise(() => pending.promise).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
      ),
    );
    const first = yield* scheduler
      .settle([
        {
          contract: RemoteModuleSchema,
          identity: 'short',
          load,
          loadIdentity: loadIdentity('deadlines'),
          timeoutMs: 10,
        },
      ])
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    const second = yield* scheduler
      .settle([
        {
          contract: RemoteModuleSchema,
          identity: 'long',
          load,
          loadIdentity: loadIdentity('deadlines'),
          timeoutMs: 100,
        },
      ])
      .pipe(Effect.forkChild);
    yield* TestClock.adjust('10 millis');
    expect(yield* Fiber.join(first)).toEqual([{ identity: 'short', reason: 'timeout', state: 'unavailable' }]);
    expect(starts).toBe(1);
    pending.resolve({ default: remoteDefault });
    expect((yield* Fiber.join(second))[0]?.state).toBe('ready');
    expect(starts).toBe(1);
  }),
);

it.effect('preserves a live second caller and permits rejoining started work after all prior callers abort', () =>
  Effect.gen(function* isolatesAbortAndAllowsOrphanRejoin() {
    for (const rejoin of [false, true]) {
      const scheduler = makeModuleEntrypointLoadScheduler();
      const pending = Promise.withResolvers<RemoteModule>();
      const started = Promise.withResolvers<null>();
      let starts = 0;
      const load = startedNamespaceLoad(
        Effect.sync(() => {
          starts += 1;
          started.resolve(null);
        }),
        Effect.tryPromise(() => pending.promise).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
        ),
      );
      const first = yield* scheduler
        .settle([{ contract: RemoteModuleSchema, identity: 'first', load, loadIdentity: loadIdentity('abort-owner') }])
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      if (rejoin) {
        yield* Fiber.interrupt(first);
      }
      const second = yield* scheduler
        .settle([{ contract: RemoteModuleSchema, identity: 'second', load, loadIdentity: loadIdentity('abort-owner') }])
        .pipe(Effect.forkChild);
      yield* TestClock.adjust('0 millis');
      if (!rejoin) {
        yield* Fiber.interrupt(first);
      }
      expect(starts).toBe(1);
      pending.resolve({ default: remoteDefault });
      expect((yield* Fiber.join(second))[0]?.state).toBe('ready');
      expect(starts).toBe(1);
    }
  }),
);

it.effect('checks opposite caller contracts separately against the same shared unknown export', () =>
  Effect.gen(function* validatesEveryCallerContract() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const pending = Promise.withResolvers<RemoteModule>();
    const started = Promise.withResolvers<null>();
    let starts = 0;
    const checks = [0, 0];
    const load = startedNamespaceLoad(
      Effect.sync(() => {
        starts += 1;
        started.resolve(null);
      }),
      Effect.tryPromise(() => pending.promise).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
      ),
    );
    const callers = yield* scheduler
      .settle([
        {
          contract: RemoteModuleSchema.check(
            Schema.makeFilter(() => {
              checks[0] = (checks[0] ?? 0) + 1;
            }),
          ),
          identity: 'accepting',
          load,
          loadIdentity: loadIdentity('contracts'),
        },
        {
          contract: RemoteModuleSchema.check(
            Schema.makeFilter(() => {
              checks[1] = (checks[1] ?? 0) + 1;
              return 'additional required export is absent';
            }),
          ),
          identity: 'requiring-extra-export',
          load,
          loadIdentity: loadIdentity('contracts'),
        },
      ])
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    pending.resolve({ default: remoteDefault });
    expect(yield* Fiber.join(callers)).toEqual([
      { identity: 'accepting', state: 'ready', value: { default: remoteDefault } },
      { identity: 'requiring-extra-export', reason: 'incompatible', state: 'unavailable' },
    ]);
    expect(starts).toBe(1);
    expect(checks).toEqual([1, 1]);
  }),
);

it.effect('isolates a throwing external namespace getter from a healthy sibling', () =>
  Effect.gen(function* settlesExternalGetterFailure() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const external = Object.defineProperty({}, 'default', {
      enumerable: true,
      get() {
        throw new TypeError('External namespace getter unavailable');
      },
    });
    const results = yield* scheduler.settle([
      {
        contract: RemoteModuleSchema,
        identity: 'throwing-getter',
        load: () =>
          Effect.tryPromise(() => Promise.resolve(external)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
          ),
        loadIdentity: loadIdentity('throwing-getter'),
      },
      {
        contract: RemoteModuleSchema,
        identity: 'healthy-getter-sibling',
        load: () =>
          Effect.tryPromise(() => Promise.resolve({ default: remoteDefault })).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
          ),
        loadIdentity: loadIdentity('healthy-getter-sibling'),
      },
    ]);
    expect(results).toEqual([
      { identity: 'throwing-getter', reason: 'incompatible', state: 'unavailable' },
      { identity: 'healthy-getter-sibling', state: 'ready', value: { default: remoteDefault } },
    ]);
  }),
);

it.effect('dispatches queued owners round robin with eight actual global slots and two per owner', () =>
  Effect.gen(function* accountsForFairPhysicalCapacity() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const owners = ['fair-a', 'fair-b', 'fair-c', 'fair-d', 'fair-e'];
    const pending = owners.flatMap((owner) =>
      Array.from({ length: 3 }, (_, index) => ({
        identity: `${owner}-${index}`,
        index,
        owner,
        promise: Promise.withResolvers<RemoteModule>(),
      })),
    );
    const full = Promise.withResolvers<null>();
    const started: string[] = [];
    const byOwner = new Map<string, number>();
    let current = 0;
    let maximum = 0;
    let maximumPerOwner = 0;
    const caller = yield* scheduler
      .settle(
        pending.map((entry) => ({
          contract: RemoteModuleSchema,
          identity: entry.identity,
          load: () =>
            Effect.tryPromise(() => {
              started.push(entry.owner);
              current += 1;
              const ownerCurrent = (byOwner.get(entry.owner) ?? 0) + 1;
              byOwner.set(entry.owner, ownerCurrent);
              maximum = Math.max(maximum, current);
              maximumPerOwner = Math.max(maximumPerOwner, ownerCurrent);
              if (started.length === MODULE_LOAD_CONCURRENCY) {
                full.resolve(null);
              }
              return entry.promise.promise;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  current -= 1;
                  byOwner.set(entry.owner, (byOwner.get(entry.owner) ?? 0) - 1);
                }),
              ),
              Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
            ),
          loadIdentity: loadIdentity(entry.owner, `page-${entry.index}`),
        })),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => full.promise);
    expect(started.slice(0, owners.length)).toEqual(owners);
    expect(current).toBe(MODULE_LOAD_CONCURRENCY);
    expect(maximumPerOwner).toBe(2);
    for (const entry of pending) {
      entry.promise.resolve({ default: remoteDefault });
    }
    expect((yield* Fiber.join(caller)).every(({ state }) => state === 'ready')).toBe(true);
    expect(started).toHaveLength(15);
    expect(maximum).toBe(MODULE_LOAD_CONCURRENCY);
    expect(maximumPerOwner).toBe(2);
    expect(current).toBe(0);
  }),
);

it.effect('does not mint a ninth slot after eight distinct permanent physical stalls time out', () =>
  Effect.gen(function* preservesExhaustedPhysicalCapacity() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const stalled = Array.from({ length: MODULE_LOAD_CONCURRENCY }, () => Promise.withResolvers<RemoteModule>());
    const full = Promise.withResolvers<null>();
    let starts = 0;
    const first = yield* scheduler
      .settle(
        stalled.map((pending, index) => ({
          contract: RemoteModuleSchema,
          identity: index,
          load: () =>
            Effect.tryPromise(() => {
              starts += 1;
              if (starts === MODULE_LOAD_CONCURRENCY) {
                full.resolve(null);
              }
              return pending.promise;
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
          loadIdentity: loadIdentity(`permanent-${index}`),
          timeoutMs: 10,
        })),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => full.promise);
    yield* TestClock.adjust('10 millis');
    expect((yield* Fiber.join(first)).every(({ state }) => state === 'unavailable')).toBe(true);
    const next = yield* scheduler
      .settle([
        {
          contract: RemoteModuleSchema,
          identity: 'ninth',
          load: () =>
            Effect.tryPromise(() => {
              starts += 1;
              return Promise.resolve({ default: remoteDefault });
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
          loadIdentity: loadIdentity('permanent-ninth'),
          timeoutMs: 10,
        },
      ])
      .pipe(Effect.forkChild);
    yield* TestClock.adjust('10 millis');
    expect(yield* Fiber.join(next)).toEqual([{ identity: 'ninth', reason: 'timeout', state: 'unavailable' }]);
    expect(starts).toBe(MODULE_LOAD_CONCURRENCY);
  }),
);

it.effect('never starts equivalent queued work after its last live waiter is abandoned', () =>
  Effect.gen(function* removesLastQueuedWaiter() {
    const scheduler = makeModuleEntrypointLoadScheduler();
    const pending = Array.from({ length: MODULE_LOAD_CONCURRENCY }, () => Promise.withResolvers<RemoteModule>());
    const full = Promise.withResolvers<null>();
    let blockers = 0;
    let queuedStarts = 0;
    const occupying = yield* scheduler
      .settle(
        pending.map((entry, index) => ({
          contract: RemoteModuleSchema,
          identity: index,
          load: () =>
            Effect.tryPromise(() => {
              blockers += 1;
              if (blockers === MODULE_LOAD_CONCURRENCY) {
                full.resolve(null);
              }
              return entry.promise;
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
          loadIdentity: loadIdentity(`queue-blocker-${index}`),
        })),
      )
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => full.promise);
    const load = () =>
      Effect.tryPromise(() => {
        queuedStarts += 1;
        return Promise.resolve({ default: remoteDefault });
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)));
    const first = yield* scheduler
      .settle([
        {
          contract: RemoteModuleSchema,
          identity: 'queued-first',
          load,
          loadIdentity: loadIdentity('abandoned-owner'),
        },
      ])
      .pipe(Effect.forkChild);
    const second = yield* scheduler
      .settle([
        {
          contract: RemoteModuleSchema,
          identity: 'queued-second',
          load,
          loadIdentity: loadIdentity('abandoned-owner'),
        },
      ])
      .pipe(Effect.forkChild);
    yield* TestClock.adjust('0 millis');
    yield* Fiber.interrupt(first);
    yield* Fiber.interrupt(second);
    for (const entry of pending) {
      entry.resolve({ default: remoteDefault });
    }
    expect((yield* Fiber.join(occupying)).every(({ state }) => state === 'ready')).toBe(true);
    const healthy = yield* scheduler.settle([
      {
        contract: RemoteModuleSchema,
        identity: 'fresh-after-abandon',
        load: () =>
          Effect.tryPromise(() => Promise.resolve({ default: remoteDefault })).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema)),
          ),
        loadIdentity: loadIdentity('fresh-after-abandon'),
      },
    ]);
    expect(healthy[0]?.state).toBe('ready');
    expect(queuedStarts).toBe(0);
  }),
);

it.effect('checks physical starts and raw settlement against the clock even before delayed deadline timers run', () =>
  Clock.clockWith((clock) => {
    let now = clock.currentTimeMillisUnsafe();
    const scheduler = makeModuleEntrypointLoadScheduler();
    const started: string[] = [];
    return scheduler
      .settle([
        {
          contract: RemoteModuleSchema,
          identity: 'late-result',
          load: () =>
            Effect.tryPromise(() => {
              started.push('first');
              now += 20;
              return Promise.resolve({ default: remoteDefault });
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
          loadIdentity: loadIdentity('clock-first'),
          timeoutMs: 10,
        },
        {
          contract: RemoteModuleSchema,
          identity: 'expired-reservation',
          load: () =>
            Effect.tryPromise(() => {
              started.push('next');
              return Promise.resolve({ default: remoteDefault });
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModuleEntrypointNamespaceSchema))),
          loadIdentity: loadIdentity('clock-next'),
          timeoutMs: 10,
        },
      ])
      .pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillis: Effect.sync(() => now),
          currentTimeMillisUnsafe: () => now,
          currentTimeNanos: clock.currentTimeNanos,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          sleep: (duration) => clock.sleep(duration),
        }),
        Effect.tap((results) =>
          Effect.sync(() => {
            expect(started).toEqual(['first']);
            expect(results).toEqual([
              { identity: 'late-result', reason: 'timeout', state: 'unavailable' },
              { identity: 'expired-reservation', reason: 'timeout', state: 'unavailable' },
            ]);
          }),
        ),
      );
  }),
);
