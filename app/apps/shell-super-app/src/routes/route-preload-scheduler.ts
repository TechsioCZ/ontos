import { Deferred, Effect, Schema } from 'effect';

export const RoutePreloadPrioritySchema = Schema.Literals(['background', 'intent']);
export type RoutePreloadPriority = typeof RoutePreloadPrioritySchema.Type;

interface Preload {
  readonly completion: Deferred.Deferred<boolean>;
  readonly key: string;
  pending: number;
  priority: RoutePreloadPriority;
  running: boolean;
  settled: boolean;
  readonly work: Effect.Effect<void>;
}

/**
 * One queue for idle menu warming and rendered links. Navigation never enters this queue: it can join an
 * existing native router flight or start immediately. Intent gets the next slot, including one reserved slot
 * while the background pool is full. Pausing never cancels a shared router flight or physical request.
 */
export const makeRoutePreloadScheduler = (backgroundConcurrency = 4) => {
  const preloads = new Map<string, Preload>();
  const idleWaiters = new Set<Deferred.Deferred<boolean>>();
  let active = 0;
  let enabled = false;

  const notifyIdle = () => {
    if (active === 0 && preloads.size === 0) {
      for (const waiter of idleWaiters) {
        Deferred.doneUnsafe(waiter, Effect.succeed(true));
      }
      idleWaiters.clear();
    }
  };

  const finish = (preload: Preload) => {
    if (!preload.settled || preload.pending > 0) {
      return;
    }
    active -= 1;
    if (preloads.get(preload.key) === preload) {
      preloads.delete(preload.key);
    }
    Deferred.doneUnsafe(preload.completion, Effect.succeed(true));
    notifyIdle();
  };

  const drain: Effect.Effect<void> = Effect.suspend(() => {
    if (!enabled) {
      return Effect.void;
    }
    const queued = [...preloads.values()].filter((preload) => !preload.running);
    const next =
      queued.find((preload) => preload.priority === 'intent') ??
      (active < backgroundConcurrency ? queued[0] : undefined);
    if (next === undefined || active >= backgroundConcurrency + (next.priority === 'intent' ? 1 : 0)) {
      return Effect.void;
    }
    next.running = true;
    active += 1;
    return Effect.forkDetach(
      next.work.pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            next.settled = true;
            finish(next);
          }).pipe(Effect.andThen(drain)),
        ),
      ),
      { startImmediately: true },
    ).pipe(Effect.andThen(drain));
  });

  return {
    awaitIdle: Effect.suspend(() => {
      if (active === 0 && preloads.size === 0) {
        return Effect.void;
      }
      return Effect.acquireUseRelease(
        Deferred.make<boolean>().pipe(Effect.tap((waiter) => Effect.sync(() => idleWaiters.add(waiter)))),
        (waiter) => Deferred.await(waiter).pipe(Effect.asVoid),
        (waiter) => Effect.sync(() => idleWaiters.delete(waiter)),
      );
    }),
    /** Reject obsolete queued context/write work; active transports still settle under their original authority. */
    invalidate: Effect.sync(() => {
      enabled = false;
      for (const preload of preloads.values()) {
        if (!preload.running) {
          Deferred.doneUnsafe(preload.completion, Effect.succeed(true));
        }
      }
      preloads.clear();
      notifyIdle();
    }),
    pause: Effect.sync(() => {
      enabled = false;
    }),
    resume: Effect.sync(() => {
      enabled = true;
    }).pipe(Effect.andThen(drain)),
    /**
     * The router's reveal budget can end before a detached owner preload does. Keep its slot until the actual
     * Promise and announced dataset work settle, not merely until the router stops waiting.
     */
    retain: (dataKey: string) =>
      Effect.sync(() => {
        const retained = [...preloads.values()].filter(
          (preload) =>
            preload.running &&
            (preload.key.split('#')[0] === dataKey ||
              (!dataKey.includes('?') && preload.key.split(/[?#]/u)[0] === dataKey)),
        );
        for (const preload of retained) {
          preload.pending += 1;
        }
        return Effect.sync(() => {
          for (const preload of retained) {
            preload.pending -= 1;
            if (preload.pending === 0 && preload.settled) {
              finish(preload);
            }
          }
        }).pipe(Effect.andThen(drain));
      }),
    schedule: (key: string, priority: RoutePreloadPriority, work: Effect.Effect<void>) =>
      Effect.suspend(() => {
        let preload = preloads.get(key);
        if (preload === undefined) {
          preload = {
            completion: Deferred.makeUnsafe<boolean>(),
            key,
            pending: 0,
            priority,
            running: false,
            settled: false,
            work,
          };
          preloads.set(key, preload);
        } else if (priority === 'intent') {
          preload.priority = priority;
        }
        return drain.pipe(Effect.andThen(Deferred.await(preload.completion)), Effect.asVoid);
      }),
  };
};

/** Document-local, like the native router and browser request cache. */
export const staffRoutePreloads = makeRoutePreloadScheduler();
