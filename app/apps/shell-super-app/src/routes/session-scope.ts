import { Clock, Effect, MutableRef, Random } from 'effect';

/**
 * The session scope is everything this document holds for the person it is signed in as: loader answers, module
 * reads, prefetches and recorded page reads. Each holder registers its reset once. Sign-in, sign-out and an identity
 * switch end the scope, and the boundary is announced in localStorage, so every other open Shell document of this
 * browser ends its scope too. A document that never sees the boundary would keep showing the previous person.
 */

const announcementKey = 'ontos.session-scope.v1';
const resets = MutableRef.make(new Set<Effect.Effect<void>>());

/** Registers a cache's reset. Caches that hold one person's answers call this when their module loads. */
export const registerSessionScopedReset = (reset: Effect.Effect<void>): void => {
  MutableRef.get(resets).add(reset);
};

/** Forgets every session-scoped answer and rejects pending prefetches in this document. Never fails. */
export const resetSessionScope: Effect.Effect<void> = Effect.suspend(() =>
  Effect.all([...MutableRef.get(resets)], { concurrency: 1, discard: true }),
);

/** A sign-in, sign-out or identity switch: forget this document's scope and tell the other documents of the browser. */
export const endBrowserSession: Effect.Effect<void> = resetSessionScope.pipe(
  Effect.andThen(
    Effect.all([Clock.currentTimeMillis, Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)], { concurrency: 2 }).pipe(
      Effect.flatMap(([now, nonce]) =>
        Effect.try(() => globalThis.localStorage.setItem(announcementKey, `${now}:${nonce}`)),
      ),
      Effect.ignore,
    ),
  ),
);

/** Calls `listener` when another document of this browser ends its session scope. Returns the stop function. */
export const onOtherSessionScopeEnded = (listener: () => void): (() => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === announcementKey) {
      listener();
    }
  };
  globalThis.addEventListener('storage', handleStorage);
  return () => globalThis.removeEventListener('storage', handleStorage);
};
