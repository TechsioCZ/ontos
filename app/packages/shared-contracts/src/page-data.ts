// @effect-diagnostics asyncFunction:off -- MF boundary: `preloadPage` is Promise-shaped because Effect is not shared across remotes; the work stays in Effect. expires: 2027-03-31.
import { Effect, Fiber, Option, Result } from 'effect';
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
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
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

interface Entry<I, A, E> {
  /** Bumped by every load start; only the newest run may settle the entry. */
  generation: number;
  inFlight: Option.Option<Fiber.Fiber<void>>;
  readonly input: I;
  snapshot: PageDataSnapshot<A, E>;
  /** Set by a module write, a failed load, or once a ready value is older than `FRESH_FOR`. */
  stale: boolean;
}

const isBrowser = (): boolean => 'document' in globalThis;

export const definePageData = <I, A, E, R>(options: {
  readonly key: (input: I) => string;
  readonly load: (input: I) => Effect.Effect<A, E, R>;
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
}): PageData<I, A, E> => {
  const entries = new Map<string, Entry<I, A, E>>();
  const listeners = new Set<() => void>();
  let writeListenerRegistered = false;
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
    if (entry.generation !== generation || Option.isNone(entry.inFlight)) {
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
    entry.generation += 1;
    const { generation } = entry;
    const previous = entry.snapshot;
    if (previous.state !== 'pending' && !previous.refreshing) {
      entry.snapshot = { ...previous, refreshing: true };
      notify();
    }
    let settled = false;
    const fiber = options.runtime.runFork(
      options.load(entry.input).pipe(
        Effect.result,
        Effect.flatMap((result) => {
          settled = true;
          settle(entry, generation, result);
          return Result.isSuccess(result) ? expireLater(entry, generation) : Effect.void;
        }),
        Effect.ensuring(Effect.sync(() => abandon(entry, generation))),
      ),
    );
    // A load that completes synchronously has already settled inside `runFork`.
    if (!settled && entry.generation === generation) {
      entry.inFlight = Option.some(fiber);
    }
    return fiber;
  };

  const onModuleWrite = (): void => {
    for (const entry of entries.values()) {
      entry.stale = true;
    }
    observedKeys.clear();
    observing = true;
    try {
      notify();
    } finally {
      observing = false;
    }
    for (const key of observedKeys) {
      const entry = entries.get(key);
      if (entry !== undefined && entry.snapshot.state === 'ready' && Option.isNone(entry.inFlight)) {
        startLoad(entry);
      }
    }
    observedKeys.clear();
  };

  const entryFor = (input: I): Entry<I, A, E> => {
    if (!writeListenerRegistered && 'addEventListener' in globalThis) {
      writeListenerRegistered = true;
      globalThis.addEventListener(moduleWriteEvent, onModuleWrite);
    }
    const key = options.key(input);
    const existing = entries.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: Entry<I, A, E> = {
      generation: 0,
      inFlight: Option.none(),
      input,
      snapshot: pageDataPending,
      stale: true,
    };
    entries.set(key, created);
    return created;
  };

  /** Returns the run a caller must wait for, or none when the current value may be served at once. */
  const begin = (input: I): Option.Option<Fiber.Fiber<void>> => {
    const entry = entryFor(input);
    if (entry.snapshot.state === 'ready') {
      if (Option.isNone(entry.inFlight) && entry.stale) {
        startLoad(entry);
      }
      return Option.none();
    }
    return Option.isSome(entry.inFlight) ? entry.inFlight : Option.some(startLoad(entry));
  };

  const preload = (input: I): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!isBrowser()) {
        return Effect.void;
      }
      const run = begin(input);
      return Option.isSome(run) ? Fiber.await(run.value).pipe(Effect.asVoid) : Effect.void;
    });

  const ensure = (input: I): void => {
    if (isBrowser()) {
      begin(input);
    }
  };

  const refresh = (input: I): Effect.Effect<void> =>
    Effect.suspend(() => (isBrowser() ? Fiber.await(startLoad(entryFor(input))).pipe(Effect.asVoid) : Effect.void));

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

  return { ensure, key: options.key, preload, refresh, snapshot, subscribe, update };
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
    // eslint-disable-next-line effect-native/no-bare-effect-run -- MF boundary: each step's load already runs on its module's runtime; this only joins them. expires: 2027-03-31.
    await Effect.runPromise(preloadAll(props));
  };
};
