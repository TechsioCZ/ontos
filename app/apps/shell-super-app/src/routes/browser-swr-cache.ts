import { Cache, Clock, Effect, Exit, Option } from 'effect';

import type { SafeTenantIdentity } from '../../shared/api.ts';
import type { ShellAuthenticationClientOptions } from '../api/auth-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

/** A cached Shell read older than this is still answered at once, and refreshed in the background. */
const REVALIDATE_AFTER_MILLIS = 30_000;
/** Past this a Shell read is read again before it is answered. */
const MAX_AGE = '10 minutes';

interface Stamped<A> {
  readonly fetchedAt: number;
  readonly value: A;
}

/**
 * A browser read cache that answers from memory and refreshes stale entries in the background, so a route loader
 * never waits on a read it already has. Concurrent reads of one key share one request. A refresh that fails or is
 * not worth keeping drops the entry, so the next read goes to the server. `immutable` reads (the answer is fixed by
 * its key) are never refreshed in the background; they are read again only once they expire.
 */
export const browserStaleWhileRevalidateCache = <Key, A, E>(
  lookup: (key: Key) => Effect.Effect<A, E>,
  options: {
    readonly capacity: number;
    readonly freshMillis?: number;
    readonly immutable?: true;
    readonly keep: (value: A) => boolean;
  },
) => {
  const cache = browserRuntime.runSync(
    Cache.makeWith(
      (key: Key) =>
        Effect.all([lookup(key), Clock.currentTimeMillis], { concurrency: 2 }).pipe(
          Effect.map(([value, fetchedAt]): Stamped<A> => ({ fetchedAt, value })),
        ),
      {
        capacity: options.capacity,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && options.keep(exit.value.value) ? (options.freshMillis ?? MAX_AGE) : 0,
      },
    ),
  );
  const refreshing = new Set<Key>();
  const revalidate = (key: Key) =>
    Effect.sync(() => refreshing.add(key)).pipe(
      Effect.andThen(
        Effect.forkDetach(
          Cache.refresh(cache, key).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => refreshing.delete(key)))),
        ),
      ),
      Effect.asVoid,
    );
  const get = (key: Key): Effect.Effect<A, E> =>
    Effect.all([Cache.get(cache, key), Clock.currentTimeMillis], { concurrency: 1 }).pipe(
      Effect.tap(([{ fetchedAt }, now]) =>
        options.immutable === true ||
        options.freshMillis !== undefined ||
        now - fetchedAt < REVALIDATE_AFTER_MILLIS ||
        refreshing.has(key)
          ? Effect.void
          : revalidate(key),
      ),
      Effect.map(([{ value }]) => value),
    );
  /**
   * Answers `alias` with the entry `from` already holds, keeping its age, when both keys name the same read (e.g. the
   * current release and its revision). An `alias` the cache already holds is left alone.
   */
  const alias = Effect.fn('BrowserStaleWhileRevalidateCache.alias')(function* aliasEntry(from: Key, aliasKey: Key) {
    if (yield* Cache.has(cache, aliasKey)) {
      return;
    }
    const entry = yield* Cache.getSuccess(cache, from);
    if (Option.isSome(entry) && options.keep(entry.value.value)) {
      yield* Cache.set(cache, aliasKey, entry.value);
    }
  });
  /** Whether the cache holds or is reading `key`. */
  const has = (key: Key): Effect.Effect<boolean> => Cache.has(cache, key);
  /** Stores an answer the server just gave for `key` in a request that also answered other keys. */
  const prime = Effect.fn('BrowserStaleWhileRevalidateCache.prime')(function* primeEntry(key: Key, value: A) {
    if (options.keep(value) && !(yield* Cache.has(cache, key))) {
      yield* Cache.set(cache, key, { fetchedAt: yield* Clock.currentTimeMillis, value });
    }
  });
  return { alias, get, has, invalidateAll: Cache.invalidateAll(cache), prime };
};

export const keyPart = '\n';

/**
 * Cache key of one browser read: base URL, person, tenant, legal entity and a read-specific part. The person is part of
 * the key, so one person's answer is never served to another person who shares the company.
 */
export const browserReadKey = (baseUrl: string, identity: SafeTenantIdentity, extra = '') =>
  [
    baseUrl,
    identity.principalId,
    identity.tenantId,
    'legalEntityId' in identity ? String(identity.legalEntityId) : '',
    extra,
  ].join(keyPart);

/** The base URL when this read may use the browser caches; `undefined` for server rendering and explicit locales. */
export const browserBaseUrl = ({ baseUrl, ...rest }: ShellAuthenticationClientOptions) =>
  'document' in globalThis && baseUrl !== undefined && rest.cookie === undefined && rest.locale === undefined
    ? String(baseUrl)
    : undefined;
