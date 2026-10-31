// @effect-diagnostics asyncFunction:off -- MF boundary: `preloadPage` is Promise-shaped because Effect is not shared across remotes; the work stays in Effect. expires: 2027-03-31.
import { Deferred, Effect, Exit, Fiber, MutableRef, Option, Result } from 'effect';
import type { ManagedRuntime } from 'effect';

/**
 * Page data shared by the Shell and every exposed module page ("prepare before reveal").
 *
 * The Shell loads a page's remote code and calls the module's optional `preloadPage(props)` export before it
 * reveals the page, so the page finds its primary data ready in its first render. A module keeps that data in a
 * `definePageData` store (one per document) and reads it synchronously with React's `useSyncExternalStore`.
 *
 * Effect is not shared across Module Federation remotes, so only plain functions and Promises cross the boundary
 * between the Shell and a remote: `ModulePagePreload` is Promise-shaped, everything inside a remote stays Effect.
 */

export interface ModulePageContext {
  /** Signed-in principal name from the Shell session, never a demo persona lookup. */
  readonly displayName?: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** Lifetime of a dataset's unfinished loads, including superseded owners. Plain functions cross the MF boundary. */
export interface PageDataWork {
  readonly onSettled: (callback: () => void) => void;
}

/** Document-wide work notification, shared even when remotes bundle separate copies of this module. */
export const pageDataWorkEvent = 'ontos:page-data-work';

declare global {
  interface WindowEventMap {
    'ontos:page-data-work': CustomEvent<PageDataWork>;
  }
}

/** Props the Shell passes to every exposed page/component and to its preloadPage. */
export interface ModulePageProps {
  readonly context?: ModulePageContext;
  readonly routeParams: Readonly<Record<string, string>>;
  /** Raw query string of the URL being opened, with leading '?', or '' (same shape as TanStack location.searchStr). */
  readonly search: string;
}

/** Optional named export `preloadPage` of an exposed module. Resolves when the page's primary data settled; never rejects. */
// eslint-disable-next-line effect-native/no-promise-shaped-port -- MF boundary: Effect is not shared across remotes. expires: 2027-03-31.
export type ModulePagePreload = (props: ModulePageProps) => Promise<void>;

export type PageDataSnapshot<A, E> =
  | { readonly state: 'pending' }
  | { readonly refreshing: boolean; readonly state: 'ready'; readonly value: A }
  | { readonly error: E; readonly refreshing: boolean; readonly state: 'failed' };

/** Frozen pending snapshot; use it as `getServerSnapshot`. */
export const pageDataPending: PageDataSnapshot<never, never> = Object.freeze({ state: 'pending' });

export interface PageData<I, A, E> {
  /** Fire-and-forget preload; call only from useEffect (cold mounts). */
  readonly ensure: (input: I) => void;
  readonly key: (input: I) => string;
  /** Starts or joins the load. Fresh ready entry (<20 s, not invalidated): completes at once. Stale ready entry: completes at once and revalidates in the background. Missing/failed: completes when settled. Never fails. */
  readonly preload: (input: I) => Effect.Effect<void>;
  /** Browser-only dependency read: returns fresh data or waits for the latest generation. Propagates load failures, including failed revalidation; never returns last-good data as fresh. */
  readonly read: (input: I) => Effect.Effect<A, E>;
  /** Re-runs the load and keeps the current value visible (refreshing: true). Use after writes. Never fails. */
  readonly refresh: (input: I) => Effect.Effect<void>;
  /** Referentially stable until that entry changes (required by useSyncExternalStore). */
  readonly snapshot: (input: I) => PageDataSnapshot<A, E>;
  readonly subscribe: (listener: () => void) => () => void;
  /** Local optimistic edit of a ready value; no-op otherwise. */
  readonly update: (input: I, f: (value: A) => A) => void;
}

/** Window event the Shell dispatches after every settled module write; every store marks all entries stale. */
export const moduleWriteEvent = 'ontos:module-write';

/** A ready value this young is served without loading again. */
const FRESH_FOR = '20 seconds';

/** Invalidate all local dependencies before any mounted store starts revalidation. */
const writeInvalidators = MutableRef.make<ReadonlySet<() => () => void>>(new Set());
const writeListenerRegistered = MutableRef.make(false);
const onModuleWrite = (): void => {
  const revalidate = Array.from(MutableRef.get(writeInvalidators), (invalidate) => invalidate());
  for (const start of revalidate) {
    start();
  }
};

interface LoadLifetime {
  active: number;
  readonly listeners: Set<() => void>;
}

interface Entry<I, A, E> {
  /** Wakes waiters immediately when a write or refresh supersedes their owner. */
  changed: Deferred.Deferred<boolean>;
  /** Current generation's result, separate from the last-good snapshot retained after a failed refresh. */
  completion: Deferred.Deferred<A, E>;
  /** Bumped by every load start and write; only the newest run may settle the entry. */
  generation: number;
  inFlight: Option.Option<Fiber.Fiber<unknown, unknown>>;
  readonly input: I;
  lifetime: LoadLifetime;
  snapshot: PageDataSnapshot<A, E>;
  /** Set by a module write, a failed load, or once a ready value is older than `FRESH_FOR`. */
  stale: boolean;
}

const isBrowser = (): boolean => 'document' in globalThis;

const supersede = <I, A, E>(entry: Entry<I, A, E>): Option.Option<Fiber.Fiber<unknown, unknown>> => {
  const previous = entry.inFlight;
  entry.generation += 1;
  entry.inFlight = Option.none();
  return previous;
};

/** Interrupt only after publishing replacements: waiters must follow them, not the obsolete owner's exit. */
const interruptObsolete = (run: Option.Option<Fiber.Fiber<unknown, unknown>>): void => {
  if (Option.isSome(run)) {
    run.value.interruptUnsafe();
  }
};

/** A preparation follows replacement owners without waiting for obsolete work to finish. */
const awaitCurrent = <I, A, E>(entry: Entry<I, A, E>): Effect.Effect<void> =>
  Effect.suspend(() => {
    const { changed, generation, inFlight } = entry;
    if (Option.isNone(inFlight)) {
      return Effect.void;
    }
    return Effect.raceFirst(Fiber.await(inFlight.value).pipe(Effect.asVoid), Deferred.await(changed)).pipe(
      Effect.andThen(Effect.suspend(() => (entry.generation === generation ? Effect.void : awaitCurrent(entry)))),
    );
  });

export const definePageData = <I, A, E, R>(options: {
  readonly key: (input: I) => string;
  readonly load: (input: I) => Effect.Effect<A, E, R>;
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
}): PageData<I, A, E> => {
  const entries = new Map<string, Entry<I, A, E>>();
  const listeners = new Set<() => void>();
  let storeRegistered = false;
  /** During a write notification, `snapshot` records the keys mounted readers re-read (React does so inside the listener). */
  let observing = false;
  const observedKeys = new Set<string>();

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const settle = (entry: Entry<I, A, E>, generation: number, result: Result.Result<A, E>): void => {
    if (entry.generation !== generation) {
      return;
    }
    entry.inFlight = Option.none();
    const previous = entry.snapshot;
    if (Result.isSuccess(result)) {
      entry.snapshot = { refreshing: false, state: 'ready', value: result.success };
      entry.stale = false;
    } else {
      entry.stale = true;
      // A failed revalidation keeps the value on screen instead of flashing an error.
      entry.snapshot =
        previous.state === 'ready'
          ? { refreshing: false, state: 'ready', value: previous.value }
          : { error: result.failure, refreshing: false, state: 'failed' };
    }
    notify();
  };

  /** A defect or interruption ends the run without a typed outcome: the entry stays as it was and is retried next time. */
  const abandon = (entry: Entry<I, A, E>, generation: number): void => {
    if (entry.generation !== generation) {
      return;
    }
    entry.inFlight = Option.none();
    entry.stale = true;
    const previous = entry.snapshot;
    if (previous.state !== 'pending' && previous.refreshing) {
      entry.snapshot = { ...previous, refreshing: false };
      notify();
    }
  };

  const expireLater = (entry: Entry<I, A, E>, generation: number): Effect.Effect<void> =>
    Effect.forkDetach(
      Effect.sleep(FRESH_FOR).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (entry.generation === generation) {
              entry.stale = true;
            }
          }),
        ),
      ),
    ).pipe(Effect.asVoid);

  const startLoad = (entry: Entry<I, A, E>): Fiber.Fiber<void> => {
    const obsolete = supersede(entry);
    const { changed, generation } = entry;
    entry.changed = Deferred.makeUnsafe<boolean>();
    const completion = Deferred.makeUnsafe<A, E>();
    entry.completion = completion;
    if (entry.lifetime.active === 0) {
      entry.lifetime = { active: 0, listeners: new Set() };
    }
    const { lifetime } = entry;
    lifetime.active += 1;
    let settled = false;
    const fiber = options.runtime.runFork(
      Effect.withFiber((run) => {
        if (entry.generation !== generation) {
          return Effect.void;
        }
        // Publish before executing user code, which can synchronously dispatch a write or wake a waiter.
        entry.inFlight = Option.some(run);
        return Effect.suspend(() => {
          const previous = entry.snapshot;
          if (previous.state !== 'pending' && !previous.refreshing) {
            entry.snapshot = { ...previous, refreshing: true };
            notify();
          }
          return options.load(entry.input);
        }).pipe(
          Effect.result,
          Effect.flatMap((result) => {
            settled = true;
            settle(entry, generation, result);
            Deferred.doneUnsafe(completion, Effect.fromResult(result));
            return Result.isSuccess(result) ? expireLater(entry, generation) : Effect.void;
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!settled) {
              abandon(entry, generation);
            }
          }),
        ),
      ),
    );
    // A runtime still building its services has not reached `withFiber` yet.
    if (entry.generation === generation && fiber.pollUnsafe() === undefined) {
      entry.inFlight = Option.some(fiber);
    }
    // Observe the fiber itself: even interruption before its Effect starts must release the lifetime.
    fiber.addObserver((exit) => {
      if (Exit.isFailure(exit)) {
        Deferred.doneUnsafe(completion, Effect.failCause(exit.cause));
      }
      lifetime.active -= 1;
      if (lifetime.active === 0) {
        for (const listener of lifetime.listeners) {
          listener();
        }
        lifetime.listeners.clear();
      }
    });
    // Completing a Deferred may resume waiters synchronously: publish the replacement before waking them.
    Deferred.doneUnsafe(changed, Effect.succeed(true));
    interruptObsolete(obsolete);
    return fiber;
  };

  const invalidateOnWrite = (): (() => void) => {
    const loadingKeys = new Set<string>();
    const obsolete: Option.Option<Fiber.Fiber<unknown, unknown>>[] = [];
    for (const [key, entry] of entries) {
      if (Option.isSome(entry.inFlight)) {
        loadingKeys.add(key);
      }
      obsolete.push(supersede(entry));
      entry.stale = true;
    }
    return () => {
      observedKeys.clear();
      observing = true;
      try {
        notify();
      } finally {
        observing = false;
      }
      for (const key of new Set([...loadingKeys, ...observedKeys])) {
        const entry = entries.get(key);
        if (
          entry !== undefined &&
          (loadingKeys.has(key) || entry.snapshot.state === 'ready') &&
          entry.stale &&
          Option.isNone(entry.inFlight)
        ) {
          startLoad(entry);
        }
      }
      observedKeys.clear();
      for (const run of obsolete) {
        interruptObsolete(run);
      }
    };
  };

  const entryFor = (input: I): Entry<I, A, E> => {
    if (!storeRegistered && 'addEventListener' in globalThis) {
      storeRegistered = true;
      MutableRef.update(writeInvalidators, (stores) => new Set([...stores, invalidateOnWrite]));
      if (!MutableRef.get(writeListenerRegistered)) {
        MutableRef.set(writeListenerRegistered, true);
        globalThis.addEventListener(moduleWriteEvent, onModuleWrite);
      }
    }
    const key = options.key(input);
    const existing = entries.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: Entry<I, A, E> = {
      changed: Deferred.makeUnsafe<boolean>(),
      completion: Deferred.makeUnsafe<A, E>(),
      generation: 0,
      inFlight: Option.none(),
      input,
      lifetime: { active: 0, listeners: new Set() },
      snapshot: pageDataPending,
      stale: true,
    };
    entries.set(key, created);
    return created;
  };

  /** Returns the run a caller must wait for, or none when the current value may be served at once. */
  const begin = (input: I): Option.Option<Fiber.Fiber<unknown, unknown>> => {
    const entry = entryFor(input);
    if (entry.snapshot.state === 'ready') {
      if (Option.isNone(entry.inFlight) && entry.stale) {
        startLoad(entry);
      }
      return Option.none();
    }
    return Option.isSome(entry.inFlight) ? entry.inFlight : Option.some(startLoad(entry));
  };

  const announceWork = ({ lifetime }: Entry<I, A, E>): void => {
    if (lifetime.active > 0) {
      globalThis.dispatchEvent(
        new CustomEvent<PageDataWork>(pageDataWorkEvent, {
          detail: {
            onSettled: (listener) => {
              if (lifetime.active === 0) {
                listener();
              } else {
                lifetime.listeners.add(listener);
              }
            },
          },
        }),
      );
    }
  };

  const preload = Effect.fn('PageData.preload')(function* preloadEntry(input: I) {
    if (!isBrowser()) {
      return;
    }
    const run = begin(input);
    const entry = entryFor(input);
    announceWork(entry);
    yield* Option.isSome(run) ? awaitCurrent(entry) : Effect.void;
  });

  const read = (input: I): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      if (!isBrowser()) {
        return Effect.die('PageData.read requires a browser document');
      }
      const entry = entryFor(input);
      if (entry.snapshot.state === 'ready' && !entry.stale && Option.isNone(entry.inFlight)) {
        return Effect.succeed(entry.snapshot.value);
      }
      if (Option.isNone(entry.inFlight)) {
        startLoad(entry);
      }
      const { changed, completion, generation } = entry;
      announceWork(entry);
      return Effect.raceFirst(
        Deferred.await(completion).pipe(Effect.exit, Effect.map(Option.some)),
        Deferred.await(changed).pipe(Effect.as(Option.none())),
      ).pipe(
        Effect.flatMap((result) =>
          entry.generation !== generation || Option.isNone(result)
            ? read(input)
            : Exit.match(result.value, { onFailure: Effect.failCause, onSuccess: Effect.succeed }),
        ),
      );
    });

  const ensure = (input: I): void => {
    if (isBrowser()) {
      begin(input);
    }
  };

  const refresh = (input: I): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!isBrowser()) {
        return Effect.void;
      }
      const entry = entryFor(input);
      startLoad(entry);
      return awaitCurrent(entry);
    });

  const update = (input: I, f: (value: A) => A): void => {
    const entry = entries.get(options.key(input));
    if (entry?.snapshot.state !== 'ready') {
      return;
    }
    entry.snapshot = { ...entry.snapshot, value: f(entry.snapshot.value) };
    notify();
  };

  const snapshot = (input: I): PageDataSnapshot<A, E> => {
    if (!isBrowser()) {
      return pageDataPending;
    }
    const key = options.key(input);
    if (observing) {
      observedKeys.add(key);
    }
    return entries.get(key)?.snapshot ?? pageDataPending;
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { ensure, key: options.key, preload, read, refresh, snapshot, subscribe, update };
};

const PRELOAD_STEP_CONCURRENCY = 8;

/** Builds the module's `preloadPage` export: runs steps concurrently, ignores failures, never rejects. */
export const modulePagePreload = (
  ...steps: readonly ((props: ModulePageProps) => Effect.Effect<void>)[]
): ModulePagePreload => {
  const preloadAll = (props: ModulePageProps): Effect.Effect<void> =>
    Effect.forEach(steps, (step) => Effect.suspend(() => step(props)).pipe(Effect.ignoreCause), {
      concurrency: PRELOAD_STEP_CONCURRENCY,
      discard: true,
    });
  return async (props) => {
    await Effect.runPromise(preloadAll(props));
  };
};
