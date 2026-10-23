import { definePageData, modulePagePreload, moduleWriteEvent, pageDataPending } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from 'effect';
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
