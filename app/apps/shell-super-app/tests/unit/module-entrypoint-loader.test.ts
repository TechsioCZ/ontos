import { expect, it } from '@app/effect-rstest';
import { Clock, Effect, Fiber, Function as Fn, Match, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
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
import {
  loadModuleEntrypointComposition,
  MODULE_LOAD_CONCURRENCY,
  resolveThenLoadModuleTarget,
  settleModuleEntrypointLoad,
  settleModuleEntrypointLoads,
} from '../../src/routes/module-entrypoint-loader.ts';

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
  const prepareSnapshot: ModuleEntrypointGatewayService['prepareSnapshot'] = (
    context,
    entrypoints,
  ) => {
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
      moduleKeys: Object.freeze(
        [...new Set(entrypoints.map(({ moduleKey }) => moduleKey))].toSorted(),
      ),
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
      check(input.snapshot, input.entrypoint).pipe(
        Effect.andThen(input.authorize),
        Effect.andThen(input.load),
      ),
  };
  return gateway;
};

const page = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'inventory.stock.page.orders',
  moduleKey: 'inventory.stock',
  role: 'page',
});
const component = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'inventory.stock.component.summary',
  moduleKey: 'inventory.stock',
  role: 'public_component',
});

const compatibleRemoteModule = (value: { readonly default: unknown }) =>
  Predicate.isFunction(value.default);

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

class RemoteLoadUnavailable extends Schema.TaggedError<RemoteLoadUnavailable>()(
  'RemoteLoadUnavailable',
  {},
) {}
const FakeUnavailableUiStateSchema = Schema.Literals(['forbidden', 'unavailable']);
type FakeUnavailableUiState = typeof FakeUnavailableUiStateSchema.Type;

const mapFakeUnavailableUiState = (
  error: ModuleStateGateError | RemoteLoadUnavailable,
): FakeUnavailableUiState =>
  Match.value(error).pipe(
    Match.tag('ModuleStateDeniedError', () => 'forbidden' as const),
    Match.tag(
      'ModuleStateCheckUnavailableError',
      'RemoteLoadUnavailable',
      () => 'unavailable' as const,
    ),
    Match.exhaustive,
  );

it.effect('preserves typed gate and remote-load failures for exhaustive UI mapping', () =>
  Effect.gen(function* verifyTypedFailures() {
    const gateFailure = yield* Effect.flip(
      loadModuleEntrypointComposition(makeFakeGateway({ unavailable: true }), trustedContext, [
        { authorize: Effect.void, entrypoint: page, load: Effect.succeed('unreachable') },
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

it.live(
  'settles browser entrypoint success, rejection, incompatibility, and timeout independently',
  () =>
    Effect.gen(function* verifySettledLoads() {
      const pending = Promise.withResolvers<{ readonly default: () => null }>();
      const [ready, unavailable, incompatible, timedOut] = yield* Effect.all(
        [
          settleModuleEntrypointLoad(
            Fn.constant(Promise.resolve({ default: remoteDefault })),
            compatibleRemoteModule,
            50,
          ),
          settleModuleEntrypointLoad(
            Fn.constant(Promise.reject(new Error('remote unavailable'))),
            compatibleRemoteModule,
            50,
          ),
          settleModuleEntrypointLoad(
            Fn.constant(Promise.resolve({ default: 'not a component' })),
            compatibleRemoteModule,
            50,
          ),
          settleModuleEntrypointLoad(Fn.constant(pending.promise), compatibleRemoteModule, 1),
        ],
        { concurrency: 'unbounded' },
      );

      expect(ready.state).toBe('ready');
      expect(unavailable).toEqual({ reason: 'unavailable', state: 'unavailable' });
      expect(incompatible).toEqual({ reason: 'incompatible', state: 'unavailable' });
      expect(timedOut).toEqual({ reason: 'timeout', state: 'unavailable' });
    }),
);

it.effect('settles several browser entrypoints without one failure hiding healthy loads', () =>
  Effect.gen(function* verifySettledLoadCollection() {
    const results = yield* settleModuleEntrypointLoads([
      {
        identity: 'documents-center/page',
        isCompatible: compatibleRemoteModule,
        load: Fn.constant(Promise.resolve({ default: remoteDefault })),
        timeoutMs: 50,
      },
      {
        identity: 'property-registry/page',
        isCompatible: compatibleRemoteModule,

        load: () => Promise.reject(new Error('remote unavailable')),
        timeoutMs: 50,
      },
      {
        identity: 'throwing-validator/page',
        isCompatible: () => {
          throw new TypeError('malformed runtime value');
        },
        load: Fn.constant(Promise.resolve({ default: remoteDefault })),
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
        identity: 'throwing-validator/page',
        reason: 'incompatible',
        state: 'unavailable',
      },
    ]);
  }),
);

interface RemoteModule {
  readonly default: () => null;
}

it.live('never starts a queued load whose deadline expired before a permit became available', () =>
  Effect.gen(function* verifyCase1() {
    const pendingLoads: PromiseWithResolvers<RemoteModule>[] = [];
    const firstWindowStarted = Promise.withResolvers<null>();
    let loadCount = 0;
    const resultsFiber = yield* Effect.forkChild(
      settleModuleEntrypointLoads(
        Array.from({ length: MODULE_LOAD_CONCURRENCY + 1 }, (_, index) => ({
          identity: `module-${index}/page`,
          isCompatible: compatibleRemoteModule,

          load: () => {
            const pending = Promise.withResolvers<RemoteModule>();
            pendingLoads.push(pending);
            loadCount += 1;
            if (loadCount === MODULE_LOAD_CONCURRENCY) {
              firstWindowStarted.resolve(null);
            }
            return Promise.resolve(pending.promise);
          },
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
    const results = yield* Clock.clockWith((clock) =>
      settleModuleEntrypointLoads(
        Array.from({ length: MODULE_LOAD_CONCURRENCY + 1 }, (_, index) => ({
          identity: `module-${index}/page`,
          isCompatible: compatibleRemoteModule,

          load: () => {
            started.push(index);
            if (index === 0) {
              const unblockAt = clock.currentTimeMillisUnsafe() + 40;
              // Busy-wait past the queued deadline without letting its timer callback run.
              while (clock.currentTimeMillisUnsafe() < unblockAt) {
                // Intentionally keep the event loop blocked.
              }
            }
            return Promise.resolve({ default: remoteDefault });
          },
          timeoutMs: index === MODULE_LOAD_CONCURRENCY ? 10 : 5000,
        })),
      ),
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
    const pendingLoads = Array.from({ length: MODULE_LOAD_CONCURRENCY }, () =>
      Promise.withResolvers<RemoteModule>(),
    );
    const firstWindowStarted = Promise.withResolvers<null>();
    const started: number[] = [];
    const caller = yield* Effect.forkChild(
      settleModuleEntrypointLoads(
        Array.from({ length: 12 }, (_, index) => ({
          identity: `module-${index}/page`,
          isCompatible: compatibleRemoteModule,

          load: () => {
            started.push(index);
            if (started.length === MODULE_LOAD_CONCURRENCY) {
              firstWindowStarted.resolve(null);
            }
            return pendingLoads[index]?.promise ?? Promise.resolve({ default: remoteDefault });
          },
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

it.effect(
  'holds a running timed-out load permit until settlement then releases it to a live queued load',
  () =>
    Effect.gen(function* verifyPermitRelease() {
      const pendingLoads = Array.from({ length: MODULE_LOAD_CONCURRENCY }, () =>
        Promise.withResolvers<RemoteModule>(),
      );
      const firstWindowStarted = Promise.withResolvers<null>();
      const queuedLoadStarted = Promise.withResolvers<null>();
      const events: string[] = [];
      const resultsFiber = yield* Effect.forkChild(
        settleModuleEntrypointLoads(
          Array.from({ length: MODULE_LOAD_CONCURRENCY + 1 }, (_, index) => ({
            identity: `module-${index}/page`,
            isCompatible: compatibleRemoteModule,

            load: () => {
              events.push(`started-${index}`);
              if (index === MODULE_LOAD_CONCURRENCY - 1) {
                firstWindowStarted.resolve(null);
              }
              const pending = pendingLoads[index];
              if (pending === undefined) {
                queuedLoadStarted.resolve(null);
                return Promise.resolve({ default: remoteDefault });
              }
              return Promise.resolve(
                pending.promise.then((value) => {
                  events.push(`settled-${index}`);
                  return value;
                }),
              );
            },
            timeoutMs: index === 0 ? 10 : 1000,
          })),
        ),
      );

      yield* Effect.promise(() => firstWindowStarted.promise);
      yield* TestClock.adjust('20 millis');
      expect(events).toEqual(
        Array.from({ length: MODULE_LOAD_CONCURRENCY }, (_, index) => `started-${index}`),
      );

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
    const pending = Promise.withResolvers<RemoteModule>();
    const loadStarted = Promise.withResolvers<null>();
    const loadSettled = Promise.withResolvers<null>();
    const resultFiber = yield* Effect.forkChild(
      settleModuleEntrypointLoads([
        {
          identity: 'late-rejection/page',
          isCompatible: compatibleRemoteModule,

          load: () => {
            loadStarted.resolve(null);
            return Promise.resolve(
              pending.promise.finally(() => {
                loadSettled.resolve(null);
              }),
            );
          },
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
    expect(result).toEqual([
      {
        identity: 'late-rejection/page',
        reason: 'timeout',
        state: 'unavailable',
      },
    ]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect.each(['selection_required', 'not_found', 'forbidden', 'unavailable'] as const)(
  'never invokes a remote loader after a %s target resolution',
  (outcome) => {
    let loads = 0;
    return Effect.gen(function* verifyRejectedTargetResolution() {
      const failure = yield* Effect.flip(
        resolveThenLoadModuleTarget(Effect.fail({ outcome }), () =>
          Effect.sync(() => {
            loads += 1;
            return 'unreachable';
          }),
        ),
      );
      expect(failure).toEqual({ outcome });
      expect(loads).toBe(0);
    });
  },
);

it.effect('invokes the lazy registry only after receiving an approved target', () =>
  Effect.gen(function* verifyApprovedTargetResolution() {
    let loads = 0;
    const target = { appId: 'inventory-app', componentKey: 'inventory.stock.page' };
    const result = yield* resolveThenLoadModuleTarget(Effect.succeed(target), (approved) =>
      Effect.sync(() => {
        loads += 1;
        return approved.componentKey;
      }),
    );
    expect(result).toBe('inventory.stock.page');
    expect(loads).toBe(1);
  }),
);
