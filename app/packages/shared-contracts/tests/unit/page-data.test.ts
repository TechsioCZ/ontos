import {
  definePageData,
  modulePagePreload,
  moduleWriteEvent,
  pageDataPending,
  pageDataWorkEvent,
} from '@app/shared-contracts/page-data';
import type { PageDataWork } from '@app/shared-contracts/page-data';
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
