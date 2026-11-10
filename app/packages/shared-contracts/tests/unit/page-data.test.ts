import {
  definePageData,
  moduleChangeEvent,
  modulePagePreload,
  moduleWriteEvent,
  pageDataPending,
  pageDataScopeKey,
  pageDataTenantScopeKey,
  pageDataWorkEvent,
} from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail, PageDataWork } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Result } from 'effect';
import { afterAll, beforeAll, expect, it } from 'effect-rstest';

const events = new EventTarget();
const browserGlobals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};

// The store only works in a document; Node gets the few window members it uses.
beforeAll(() => {
  for (const [name, value] of Object.entries(browserGlobals)) {
    Reflect.set(globalThis, name, value);
  }
});

afterAll(() => {
  for (const name of Object.keys(browserGlobals)) {
    Reflect.deleteProperty(globalThis, name);
  }
});

const runtime = ManagedRuntime.make(Layer.empty);

const makeCountingStore = (options?: { readonly fail?: () => boolean }) => {
  let loads = 0;
  const store = definePageData({
    key: (input: { readonly id: string }) => input.id,
    load: (input: { readonly id: string }) =>
      Effect.suspend(() => {
        loads += 1;
        return options?.fail?.() === true ? Effect.fail('boom' as const) : Effect.succeed(`${input.id}#${loads}`);
      }),
    runtime,
  });
  return { loads: () => loads, store };
};

it.effect('strict bounded details synchronously reuse complete data, but never stale data after a denial', () =>
  Effect.gen(function* strictDetails() {
    let denied = false;
    let loads = 0;
    const store = definePageData({
      key: (id: string) => id,
      load: (id: string) =>
        Effect.suspend(() => {
          loads += 1;
          return denied ? Effect.fail('denied' as const) : Effect.succeed({ id, lines: ['complete'] });
        }),
      maxEntries: 2,
      retainStale: false,
      runtime,
    });
    yield* store.read('a');
    const warmed = store.snapshot('a');
    expect(warmed).toEqual({ refreshing: false, state: 'ready', value: { id: 'a', lines: ['complete'] } });
    yield* store.read('a');
    expect(store.snapshot('a')).toBe(warmed);
    expect(loads).toBe(1);
    denied = true;
    store.invalidate();
    expect(store.snapshot('a')).toBe(pageDataPending);
    expect(yield* Effect.result(store.read('a'))).toEqual(Result.fail('denied'));
    expect(store.snapshot('a')).toEqual({ error: 'denied', refreshing: false, state: 'failed' });
    denied = false;
    yield* store.read('a');
    expect(loads).toBe(3);
    expect(store.snapshot('a').state).toBe('ready');
  }),
);

it.effect('bounded details evict the least recently read inactive entry', () =>
  Effect.gen(function* boundedDetails() {
    const store = definePageData({
      key: (id: string) => id,
      load: (id: string) => Effect.succeed(id),
      maxEntries: 2,
      runtime,
    });
    yield* store.read('a');
    yield* store.read('b');
    yield* store.read('a');
    yield* store.read('c');
    expect(store.snapshot('b')).toBe(pageDataPending);
    expect(store.snapshot('a').state).toBe('ready');
    expect(store.snapshot('c').state).toBe('ready');
  }),
);

it.effect('a background observer cannot start unleased detail work outside its cancellable batch', () =>
  Effect.gen(function* leasedBackground() {
    let loads = 0;
    const store = definePageData({
      cancelWhenUnused: true,
      key: (id: string) => id,
      load: (id: string) =>
        Effect.sync(() => {
          loads += 1;
          return id;
        }),
      maxEntries: 2,
      retainStale: false,
      runtime,
    });
    yield* store.read('a');
    const unsubscribe = store.subscribe(() => {
      store.snapshot('a');
    });
    store.invalidate();
    expect(loads).toBe(1);
    expect(store.snapshot('a')).toBe(pageDataPending);
    unsubscribe();
  }),
);

it.effect('cancelling background prefetch preserves a joined foreground read and releases the last owner', () =>
  Effect.gen(function* cancellation() {
    const started = yield* Deferred.make<true>();
    const stopped = yield* Deferred.make<true>();
    let loads = 0;
    const store = definePageData({
      cancelWhenUnused: true,
      key: (id: string) => id,
      load: (_id: string) =>
        Effect.sync(() => {
          loads += 1;
        }).pipe(
          Effect.andThen(Deferred.succeed(started, true)),
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, true)),
        ),
      maxEntries: 2,
      retainStale: false,
      runtime,
    });
    const background = yield* Effect.forkChild(store.read('a'));
    yield* Deferred.await(started);
    const foreground = yield* Effect.forkChild(store.read('a'));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(background);
    expect(loads).toBe(1);
    expect(yield* Deferred.isDone(stopped)).toBe(false);
    yield* Fiber.interrupt(foreground);
    yield* Deferred.await(stopped);
    expect(store.snapshot('a')).toBe(pageDataPending);
  }),
);

it('detail identity includes the tenant, company, principal and module and rejects missing context', () => {
  const context = { legalEntityId: 'company', principalId: 'principal', tenantId: 'tenant' };
  const key = pageDataScopeKey(context, 'orders');
  expect(pageDataScopeKey(undefined, 'orders')).toBeUndefined();
  for (const field of ['legalEntityId', 'principalId', 'tenantId'] as const) {
    expect(pageDataScopeKey({ ...context, [field]: 'other' }, 'orders')).not.toBe(key);
    expect(pageDataScopeKey({ ...context, [field]: '' }, 'orders')).toBeUndefined();
  }
  expect(pageDataScopeKey(context, 'customers')).not.toBe(key);
});

it('tenant-only identity includes the tenant, principal and module while company keys keep their company guard', () => {
  const tenantContext = { principalId: 'principal', tenantId: 'tenant' };
  const tenantKey = pageDataTenantScopeKey(tenantContext, 'projects.core');
  expect(pageDataTenantScopeKey(undefined, 'projects.core')).toBeUndefined();
  for (const field of ['principalId', 'tenantId'] as const) {
    expect(pageDataTenantScopeKey({ ...tenantContext, [field]: 'other' }, 'projects.core')).not.toBe(tenantKey);
    expect(pageDataTenantScopeKey({ ...tenantContext, [field]: '' }, 'projects.core')).toBeUndefined();
  }
  expect(pageDataTenantScopeKey(tenantContext, 'customers')).not.toBe(tenantKey);
  expect(
    pageDataScopeKey({ legalEntityId: 'company', principalId: 'principal', tenantId: 'tenant' }, 'projects.core'),
  ).not.toBe(tenantKey);
  expect(
    pageDataScopeKey({ legalEntityId: '', principalId: 'principal', tenantId: 'tenant' }, 'projects.core'),
  ).toBeUndefined();
});

it.live(
  'TTL revalidates only the mounted strict detail, not every row warmed by the table',
  () =>
    Effect.gen(function* detailTtl() {
      const loads: string[] = [];
      const store = definePageData({
        cancelWhenUnused: true,
        key: (id: string) => id,
        load: (id: string) =>
          Effect.sync(() => {
            loads.push(id);
            return id;
          }),
        maxEntries: 2,
        retainStale: false,
        runtime,
      });
      yield* store.read('open');
      yield* store.read('background');
      const unsubscribe = store.subscribe(() => {
        store.snapshot('open');
      }, 'open');
      yield* Effect.sleep('20100 millis');
      expect(loads).toEqual(['open', 'background', 'open']);
      expect(store.snapshot('open').state).toBe('ready');
      expect(store.snapshot('background')).toBe(pageDataPending);
      unsubscribe();
      expect(store.snapshot('open').state).toBe('ready');
    }),
  30_000,
);

it.effect('concurrent preloads share one load', () =>
  Effect.gen(function* sharedLoad() {
    const gate = yield* Deferred.make<true>();
    let loads = 0;
    const store = definePageData({
      key: (input: string) => input,
      load: (input: string) =>
        Effect.suspend(() => {
          loads += 1;
          return Deferred.await(gate).pipe(Effect.as(input.toUpperCase()));
        }),
      runtime,
    });
    const first = store.preload('a');
    const second = store.preload('a');
    const both = yield* Effect.forkChild(Effect.all([first, second], { concurrency: 2 }));
    store.ensure('a');
    yield* Effect.yieldNow;
    expect(store.snapshot('a')).toBe(pageDataPending);
    yield* Deferred.succeed(gate, true);
    yield* Fiber.join(both);
    expect(loads).toBe(1);
    expect(store.snapshot('a')).toEqual({ refreshing: false, state: 'ready', value: 'A' });
  }),
);

it.live('a fresh entry is served without loading; a stale entry is served and revalidated', () =>
  Effect.gen(function* staleServed() {
    const gate = yield* Deferred.make<true>();
    let loads = 0;
    const store = definePageData({
      key: (input: string) => input,
      load: (input: string) =>
        Effect.suspend(() => {
          loads += 1;
          const value = `${input}#${loads}`;
          return loads === 1 ? Effect.succeed(value) : Deferred.await(gate).pipe(Effect.as(value));
        }),
      runtime,
    });
    yield* store.preload('x');
    yield* store.preload('x');
    expect(loads).toBe(1);
    expect(store.snapshot('x')).toEqual({ refreshing: false, state: 'ready', value: 'x#1' });

    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    // Completes at once with the stale value while the revalidation waits on the gate.
    yield* store.preload('x');
    expect(loads).toBe(2);
    expect(store.snapshot('x')).toEqual({ refreshing: true, state: 'ready', value: 'x#1' });
    yield* Deferred.succeed(gate, true);
    yield* Effect.sleep('10 millis');
    expect(store.snapshot('x')).toEqual({ refreshing: false, state: 'ready', value: 'x#2' });
  }),
);

it.effect('refresh keeps the value visible and a failed refresh keeps it too', () =>
  Effect.gen(function* refreshKeepsValue() {
    let failing = false;
    const { store } = makeCountingStore({ fail: () => failing });
    yield* store.preload({ id: 'r' });
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe(() => {
      seen.push(store.snapshot({ id: 'r' }));
    });
    yield* store.refresh({ id: 'r' });
    expect(seen).toEqual([
      { refreshing: true, state: 'ready', value: 'r#1' },
      { refreshing: false, state: 'ready', value: 'r#2' },
    ]);
    failing = true;
    yield* store.refresh({ id: 'r' });
    expect(store.snapshot({ id: 'r' })).toEqual({ refreshing: false, state: 'ready', value: 'r#2' });
    unsubscribe();
  }),
);

it.effect('a first-time failure is reported as failed', () =>
  Effect.gen(function* firstFailure() {
    const { store } = makeCountingStore({ fail: () => true });
    yield* store.preload({ id: 'f' });
    expect(store.snapshot({ id: 'f' })).toEqual({ error: 'boom', refreshing: false, state: 'failed' });
  }),
);

it.live('the write event revalidates entries that mounted readers observe', () =>
  Effect.gen(function* writeRevalidates() {
    const { loads, store } = makeCountingStore();
    yield* store.preload({ id: 'seen' });
    yield* store.preload({ id: 'unseen' });
    expect(loads()).toBe(2);
    const unsubscribe = store.subscribe(() => {
      store.snapshot({ id: 'seen' });
    });
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(3);
    expect(store.snapshot({ id: 'seen' })).toMatchObject({ value: 'seen#3' });
    expect(store.snapshot({ id: 'unseen' })).toMatchObject({ value: 'unseen#2' });
    unsubscribe();
    // The unobserved entry was marked stale, so its next preload revalidates it.
    yield* store.preload({ id: 'unseen' });
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(4);
  }),
);

it.live('a live change revalidates only what mounted readers show and retries a shown failure', () =>
  Effect.gen(function* liveChangeRevalidates() {
    let failing = true;
    const { loads, store } = makeCountingStore({ fail: () => failing });
    yield* store.preload({ id: 'shown' });
    expect(store.snapshot({ id: 'shown' })).toMatchObject({ state: 'failed' });
    failing = false;
    yield* store.preload({ id: 'hidden' });
    expect(loads()).toBe(2);
    const unsubscribe = store.subscribe(() => {
      store.snapshot({ id: 'shown' });
    });
    globalThis.dispatchEvent(new Event(moduleChangeEvent));
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(3);
    expect(store.snapshot({ id: 'shown' })).toMatchObject({ state: 'ready', value: 'shown#3' });
    expect(store.snapshot({ id: 'hidden' })).toMatchObject({ value: 'hidden#2' });
    unsubscribe();
  }),
);

/** A strict store (as the admin details) mounted on one entry; `changesFrom` names the apps it shows. */
const mountScopedStore = (scope: { readonly changesFrom?: readonly string[] }) => {
  let loads = 0;
  const store = definePageData({
    ...scope,
    key: (id: string) => id,
    load: (id: string) =>
      Effect.sync(() => {
        loads += 1;
        return `${id}#${loads}`;
      }),
    retainStale: false,
    runtime,
  });
  const unsubscribe = store.subscribe(() => {
    store.snapshot('shown');
  }, 'shown');
  return { loads: () => loads, store, unsubscribe };
};

/** The Shell's live channel reports a change of `apps`. */
const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  globalThis.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

it.live('a live change from an app the store does not show leaves it untouched', () =>
  Effect.gen(function* unrelatedChange() {
    const scoped = mountScopedStore({ changesFrom: ['merchandise', 'party-registry'] });
    const unscoped = mountScopedStore({});
    yield* scoped.store.preload('shown');
    yield* unscoped.store.preload('shown');
    const shown = scoped.store.snapshot('shown');
    dispatchChange(['finance-billing', 'shell']);
    yield* Effect.sleep('10 millis');
    expect(scoped.loads()).toBe(1);
    expect(scoped.store.snapshot('shown')).toBe(shown);
    // A fresh entry is served without a request: the change did not mark it stale.
    yield* scoped.store.read('shown');
    expect(scoped.loads()).toBe(1);
    // A store that declares nothing keeps reacting to every change.
    expect(unscoped.loads()).toBe(2);
    scoped.unsubscribe();
    unscoped.unsubscribe();
  }),
);

it.live('a live change from a declared app reloads the store as before', () =>
  Effect.gen(function* declaredChange() {
    const { loads, store, unsubscribe } = mountScopedStore({ changesFrom: ['merchandise', 'party-registry'] });
    yield* store.preload('shown');
    dispatchChange(['party-registry']);
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(2);
    expect(store.snapshot('shown')).toMatchObject({ state: 'ready', value: 'shown#2' });
    dispatchChange(['crm', 'merchandise']);
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(3);
    unsubscribe();
  }),
);

it.live('a change without an app list, a reset and a write reload every scoped store', () =>
  Effect.gen(function* everythingChanged() {
    const { loads, store, unsubscribe } = mountScopedStore({ changesFrom: ['merchandise'] });
    yield* store.preload('shown');
    globalThis.dispatchEvent(new Event(moduleChangeEvent));
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(2);
    dispatchChange('all');
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(3);
    globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { other: true } }));
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(4);
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(5);
    store.invalidate();
    yield* Effect.sleep('10 millis');
    expect(loads()).toBe(6);
    unsubscribe();
  }),
);

it.effect('snapshots are referentially stable until the entry changes; update edits a ready value', () =>
  Effect.gen(function* stableSnapshots() {
    const { store } = makeCountingStore();
    expect(store.snapshot({ id: 's' })).toBe(pageDataPending);
    yield* store.preload({ id: 's' });
    const first = store.snapshot({ id: 's' });
    expect(store.snapshot({ id: 's' })).toBe(first);
    store.update({ id: 's' }, (value) => `${value}!`);
    const second = store.snapshot({ id: 's' });
    expect(second).not.toBe(first);
    expect(second).toEqual({ refreshing: false, state: 'ready', value: 's#1!' });
    expect(store.snapshot({ id: 's' })).toBe(second);
    store.update({ id: 'missing' }, (value) => value);
    expect(store.snapshot({ id: 'missing' })).toBe(pageDataPending);
  }),
);

it.live('a derived load waits for fresh dependency data without delaying stale-ready preload', () =>
  Effect.gen(function* freshDependency() {
    const renewal = yield* Deferred.make<boolean>();
    const sourceStarted = yield* Deferred.make<boolean>();
    let version = 1;
    const source = definePageData({
      key: (input: string) => input,
      load: () => {
        const current = version;
        return current === 1
          ? Effect.succeed(current)
          : Deferred.succeed(sourceStarted, true).pipe(Effect.andThen(Deferred.await(renewal)), Effect.as(current));
      },
      runtime,
    });
    const derived = definePageData({
      key: (input: string) => input,
      load: (input: string) => source.read(input).pipe(Effect.map((value) => value * 10)),
      runtime,
    });
    expect(yield* derived.read('key')).toBe(10);
    version = 2;
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    yield* derived.preload('key');
    yield* Deferred.await(sourceStarted);
    expect(source.snapshot('key')).toEqual({ refreshing: true, state: 'ready', value: 1 });
    expect(derived.snapshot('key')).toEqual({ refreshing: true, state: 'ready', value: 10 });
    const reading = yield* derived.read('key').pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(reading.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(renewal, true);
    expect(yield* Fiber.join(reading)).toBe(20);
    expect(source.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 2 });
    expect(derived.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 20 });
    yield* derived.preload('key');
    expect(yield* derived.read('key')).toBe(20);
  }),
);

it.effect('mounted derived revalidation sees a write before its dependency listener runs', () =>
  Effect.gen(function* writeListenerOrdering() {
    let version = 1;
    const source = definePageData({
      key: (input: string) => input,
      load: () => Effect.succeed(version),
      runtime,
    });
    const derived = definePageData({
      key: (input: string) => input,
      load: (input: string) => source.read(input).pipe(Effect.map((value) => value * 10)),
      runtime,
    });
    // Register the derived write listener first, as a cold derived read does in production.
    expect(yield* derived.read('key')).toBe(10);
    const unsubscribe = derived.subscribe(() => {
      derived.snapshot('key');
    });
    yield* Effect.gen(function* mountedWrite() {
      version = 2;
      globalThis.dispatchEvent(new Event(moduleWriteEvent));
      expect(yield* derived.read('key')).toBe(20);
      expect(yield* source.read('key')).toBe(2);
      expect(derived.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 20 });
    }).pipe(Effect.ensuring(Effect.sync(unsubscribe)));
  }),
);

it.effect('fresh reads reuse ready values and share cold loads with preloads', () =>
  Effect.gen(function* sharedFreshReads() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    let loads = 0;
    const source = definePageData({
      key: (input: string) => input,
      load: () => {
        loads += 1;
        return Deferred.succeed(started, true).pipe(Effect.andThen(Deferred.await(release)), Effect.as(loads));
      },
      runtime,
    });
    const first = yield* source.read('key').pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const second = yield* source.read('key').pipe(Effect.forkChild);
    const preparation = yield* source.preload('key').pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(loads).toBe(1);
    yield* Deferred.succeed(release, true);
    expect(yield* Fiber.join(first)).toBe(1);
    expect(yield* Fiber.join(second)).toBe(1);
    yield* Fiber.join(preparation);
    expect(yield* source.read('key')).toBe(1);
    expect(loads).toBe(1);
  }),
);

it.effect('dependency refresh failures fail derived reads instead of publishing last-good data as fresh', () =>
  Effect.gen(function* dependencyFailure() {
    let failing = false;
    let version = 1;
    const source = definePageData({
      key: (input: string) => input,
      load: () => (failing ? Effect.fail('dependency unavailable') : Effect.succeed(version)),
      runtime,
    });
    let computations = 0;
    const derived = definePageData({
      key: (input: string) => input,
      load: (input: string) =>
        source.read(input).pipe(
          Effect.map((value) => {
            computations += 1;
            return value * 10;
          }),
        ),
      runtime,
    });
    expect(yield* derived.read('key')).toBe(10);
    failing = true;
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    expect(yield* derived.read('key').pipe(Effect.result)).toEqual(Result.fail('dependency unavailable'));
    expect(computations).toBe(1);
    expect(source.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 1 });
    expect(derived.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 10 });
    expect(yield* derived.read('cold').pipe(Effect.result)).toEqual(Result.fail('dependency unavailable'));
    expect(derived.snapshot('cold')).toEqual({
      error: 'dependency unavailable',
      refreshing: false,
      state: 'failed',
    });
    failing = false;
    version = 2;
    expect(yield* derived.read('key')).toBe(20);
    expect(computations).toBe(2);
  }),
);

it.live('fresh reads receive asynchronous revalidation failures without retrying or serving last-good data', () =>
  Effect.gen(function* asynchronousReadFailure() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    let loads = 0;
    const source = definePageData({
      key: (input: string) => input,
      load: () => {
        loads += 1;
        return loads === 1
          ? Effect.succeed(loads)
          : Deferred.succeed(started, true).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.fail('renewal failed')),
            );
      },
      runtime,
    });
    expect(yield* source.read('key')).toBe(1);
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    yield* source.preload('key');
    yield* Deferred.await(started);
    const reading = yield* source.read('key').pipe(Effect.result, Effect.forkChild);
    yield* Effect.yieldNow;
    expect(reading.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(release, true);
    expect(yield* Fiber.join(reading)).toEqual(Result.fail('renewal failed'));
    expect(source.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 1 });
    expect(loads).toBe(2);
  }),
);

it.effect('fresh reads follow a synchronous startup write to the replacement result', () =>
  Effect.gen(function* startupReadWrite() {
    let loads = 0;
    const source = definePageData({
      key: (input: string) => input,
      load: () => {
        loads += 1;
        const value = loads;
        if (value === 1) {
          globalThis.dispatchEvent(new Event(moduleWriteEvent));
        }
        return Effect.succeed(value);
      },
      runtime,
    });
    expect(yield* source.read('key')).toBe(2);
    expect(source.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 2 });
    expect(loads).toBe(2);
  }),
);

it.live('fresh dependency reads follow write replacements without waiting for obsolete owners', () =>
  Effect.gen(function* supersededFreshRead() {
    const started = yield* Deferred.make<boolean>();
    const obsolete = yield* Deferred.make<boolean>();
    const obsoleteFinished = yield* Deferred.make<boolean>();
    let loads = 0;
    const source = definePageData({
      key: (input: string) => input,
      load: () => {
        loads += 1;
        return loads === 1
          ? Deferred.succeed(started, true).pipe(
              Effect.andThen(Deferred.await(obsolete).pipe(Effect.uninterruptible)),
              Effect.ensuring(Deferred.succeed(obsoleteFinished, true)),
              Effect.as(1),
            )
          : Effect.succeed(loads);
      },
      runtime,
    });
    const reading = yield* source.read('key').pipe(Effect.forkChild);
    yield* Deferred.await(started);
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    expect(yield* Fiber.join(reading)).toBe(2);
    yield* Deferred.succeed(obsolete, true);
    yield* Deferred.await(obsoleteFinished);
    expect(yield* source.read('key')).toBe(2);
    expect(loads).toBe(2);
  }),
);

it.effect('fresh reads propagate factory defects and remain retryable', () =>
  Effect.gen(function* freshReadDefect() {
    let loads = 0;
    const source = definePageData({
      key: (input: string) => input,
      load: () => {
        loads += 1;
        if (loads === 1) {
          throw new Error('factory defect');
        }
        return Effect.succeed(loads);
      },
      runtime,
    });
    expect(Exit.isFailure(yield* source.read('key').pipe(Effect.exit))).toBe(true);
    expect(source.snapshot('key')).toBe(pageDataPending);
    expect(yield* source.read('key')).toBe(2);
  }),
);

it.effect('modulePagePreload runs steps concurrently and never rejects', () =>
  Effect.gen(function* preloadNeverRejects() {
    const visited: string[] = [];
    const preloadPage = modulePagePreload(
      (props) =>
        Effect.sync(() => {
          visited.push(`a:${props.search}`);
        }),
      () => Effect.die('ignored defect'),
      (props) =>
        Effect.sync(() => {
          visited.push(`b:${props.routeParams['id'] ?? ''}`);
        }),
    );
    yield* Effect.promise(() => preloadPage({ routeParams: { id: '7' }, search: '?q=1' }));
    expect(visited.toSorted()).toEqual(['a:?q=1', 'b:7']);
  }),
);

it.live('waiting preparations follow a write replacement before the obsolete owner finishes', () =>
  Effect.gen(function* replacementReadiness() {
    const started = yield* Deferred.make<boolean>();
    const obsolete = yield* Deferred.make<boolean>();
    const obsoleteFinished = yield* Deferred.make<boolean>();
    const replacement = yield* Deferred.make<boolean>();
    let loads = 0;
    const store = definePageData({
      key: (input: string) => input,
      load: () =>
        Effect.suspend(() => {
          loads += 1;
          const value = loads;
          return value === 1
            ? Deferred.succeed(started, true).pipe(
                Effect.andThen(Deferred.await(obsolete).pipe(Effect.uninterruptible)),
                Effect.ensuring(Deferred.succeed(obsoleteFinished, true)),
                Effect.as(value),
              )
            : Deferred.await(replacement).pipe(Effect.as(value));
        }),
      runtime,
    });
    const original = yield* store.preload('key').pipe(Effect.forkChild);
    yield* Deferred.await(started);
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    const joined = yield* store.preload('key').pipe(Effect.forkChild);
    yield* Deferred.succeed(replacement, true);
    yield* Effect.all([Fiber.join(original), Fiber.join(joined)], { concurrency: 2 }).pipe(Effect.timeout('1 second'));
    expect(loads).toBe(2);
    expect(store.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 2 });

    // An obsolete success must not overwrite the replacement or make another preload necessary.
    yield* Deferred.succeed(obsolete, true);
    yield* Deferred.await(obsoleteFinished);
    yield* Effect.yieldNow;
    yield* store.preload('key');
    expect(loads).toBe(2);
    expect(store.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 2 });
  }),
);

it.live('an overtaken refresh cannot publish or clear refreshing while its replacement is pending', () =>
  Effect.gen(function* refreshGeneration() {
    const obsolete = yield* Deferred.make<boolean>();
    const obsoleteFinished = yield* Deferred.make<boolean>();
    const replacement = yield* Deferred.make<boolean>();
    let loads = 0;
    const store = definePageData({
      key: (input: string) => input,
      load: () =>
        Effect.suspend(() => {
          loads += 1;
          const value = loads;
          if (value === 2) {
            return Deferred.await(obsolete).pipe(
              Effect.uninterruptible,
              Effect.ensuring(Deferred.succeed(obsoleteFinished, true)),
              Effect.as(value),
            );
          }
          return value === 1 ? Effect.succeed(value) : Deferred.await(replacement).pipe(Effect.as(value));
        }),
      runtime,
    });
    yield* store.preload('key');
    const refreshing = yield* store.refresh('key').pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    expect(loads).toBe(3);
    expect(store.snapshot('key')).toEqual({ refreshing: true, state: 'ready', value: 1 });
    yield* Deferred.succeed(obsolete, true);
    yield* Deferred.await(obsoleteFinished);
    yield* Effect.yieldNow;
    expect(store.snapshot('key')).toEqual({ refreshing: true, state: 'ready', value: 1 });
    expect(refreshing.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(replacement, true);
    yield* Fiber.join(refreshing);
    expect(store.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 3 });
  }),
);

it.live('work lifetime includes superseded loads even after the replacement is ready', () =>
  Effect.gen(function* realWorkLifetime() {
    const obsolete = yield* Deferred.make<boolean>();
    const replacement = yield* Deferred.make<boolean>();
    const released = yield* Deferred.make<boolean>();
    let releases = 0;
    let loads = 0;
    const observe = (event: CustomEvent<PageDataWork>): void => {
      event.detail.onSettled(() => {
        releases += 1;
        Deferred.doneUnsafe(released, Effect.succeed(true));
      });
    };
    const store = definePageData({
      key: (input: string) => input,
      load: () =>
        Effect.suspend(() => {
          loads += 1;
          const value = loads;
          const waiting = Deferred.await(value === 1 ? obsolete : replacement);
          // An uncancellable transport may outlive its owner; its lifetime must still be excluded.
          return (value === 1 ? Effect.uninterruptible(waiting) : waiting).pipe(Effect.as(value));
        }),
      runtime,
    });
    globalThis.addEventListener(pageDataWorkEvent, observe);
    yield* Effect.gen(function* observedWork() {
      const preparing = yield* store.preload('key').pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      globalThis.dispatchEvent(new Event(moduleWriteEvent));
      yield* Deferred.succeed(replacement, true);
      yield* Fiber.join(preparing);
      expect(store.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 2 });
      expect(releases).toBe(0);
      yield* Deferred.succeed(obsolete, true);
      yield* Deferred.await(released);
      expect(releases).toBe(1);
    }).pipe(Effect.ensuring(Effect.sync(() => globalThis.removeEventListener(pageDataWorkEvent, observe))));
  }),
);

it.live('a synchronous load factory defect releases its lifetime and permits later owners to settle', () =>
  Effect.gen(function* synchronousFactoryDefect() {
    const retry = yield* Deferred.make<boolean>();
    const renewal = yield* Deferred.make<boolean>();
    let loads = 0;
    let announcements = 0;
    let releases = 0;
    const observe = (event: CustomEvent<PageDataWork>): void => {
      announcements += 1;
      event.detail.onSettled(() => {
        releases += 1;
      });
    };
    const store = definePageData({
      key: (input: string) => input,
      load: () => {
        loads += 1;
        if (loads === 1) {
          throw new Error('synchronous factory defect');
        }
        return Deferred.await(loads === 2 ? retry : renewal).pipe(Effect.as(loads));
      },
      runtime,
    });
    globalThis.addEventListener(pageDataWorkEvent, observe);
    yield* Effect.gen(function* observedFactoryRecovery() {
      expect(Exit.isSuccess(yield* store.preload('key').pipe(Effect.exit))).toBe(true);
      expect(store.snapshot('key')).toBe(pageDataPending);
      const preparing = yield* store.preload('key').pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(loads).toBe(2);
      expect(announcements).toBe(1);
      expect(releases).toBe(0);
      yield* Deferred.succeed(retry, true);
      yield* Fiber.join(preparing);
      expect(releases).toBe(1);
      expect(store.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 2 });

      globalThis.dispatchEvent(new Event(moduleWriteEvent));
      yield* store.preload('key');
      expect(announcements).toBe(2);
      expect(store.snapshot('key')).toEqual({ refreshing: true, state: 'ready', value: 2 });
      yield* Deferred.succeed(renewal, true);
      yield* Effect.yieldNow;
      expect(store.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 3 });
      expect(releases).toBe(2);
    }).pipe(Effect.ensuring(Effect.sync(() => globalThis.removeEventListener(pageDataWorkEvent, observe))));
  }),
);

it.effect('a synchronous refresh factory defect keeps the last good value and can be retried', () =>
  Effect.gen(function* synchronousRefreshDefect() {
    let loads = 0;
    const store = definePageData({
      key: (input: string) => input,
      load: () => {
        loads += 1;
        if (loads === 2) {
          throw new Error('synchronous refresh factory defect');
        }
        return Effect.succeed(loads);
      },
      runtime,
    });
    yield* store.preload('key');
    yield* store.refresh('key');
    expect(store.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 1 });
    yield* store.preload('key');
    expect(loads).toBe(3);
    expect(store.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 3 });
  }),
);

it.live('a write interrupts obsolete continuations after publishing the replacement', () =>
  Effect.gen(function* cancelledContinuation() {
    const started = yield* Deferred.make<boolean>();
    const oldRead = yield* Deferred.make<boolean>();
    const cancelled = yield* Deferred.make<boolean>();
    let loads = 0;
    let obsoleteContinuations = 0;
    const store = definePageData({
      key: (input: string) => input,
      load: () =>
        Effect.suspend(() => {
          loads += 1;
          return loads === 1
            ? Deferred.succeed(started, true).pipe(
                Effect.andThen(Deferred.await(oldRead)),
                Effect.andThen(
                  Effect.sync(() => {
                    obsoleteContinuations += 1;
                  }),
                ),
                Effect.as(1),
                Effect.onInterrupt(() => Deferred.succeed(cancelled, true)),
              )
            : Effect.succeed(loads);
        }),
      runtime,
    });
    const preparing = yield* store.preload('key').pipe(Effect.forkChild);
    yield* Deferred.await(started);
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    expect(loads).toBe(2);
    yield* Fiber.join(preparing);
    yield* Deferred.await(cancelled);
    yield* Deferred.succeed(oldRead, true);
    yield* Effect.yieldNow;
    expect(obsoleteContinuations).toBe(0);
    expect(store.snapshot('key')).toEqual({ refreshing: false, state: 'ready', value: 2 });
  }),
);
