import { Effect, Fiber, MutableRef } from 'effect';
import { useEffect, useState } from 'react';

import type { AccessAdministrationPage } from '../../shared/access-admin-api.ts';
import { listAccessAdministrationPages } from '../api/auth-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { browserStaleWhileRevalidateCache } from './browser-swr-cache.ts';
import { registerSessionScopedReset } from './session-scope.ts';

type Pages = readonly AccessAdministrationPage[];

/**
 * The access administration pages one person may open in one tenant, as the Shell's gate answers them. Asked once per
 * person and tenant and kept for the document; an answer that could not be read offers no page and is asked again.
 */
const accessPagesCache = browserStaleWhileRevalidateCache(
  (_personAndTenant: string) => listAccessAdministrationPages().pipe(Effect.map(({ pages }) => pages)),
  { capacity: 4, keep: () => true },
);
/** The last answer per person and tenant, so the next page renders the navigation without waiting for the cache. */
const answered = MutableRef.make<ReadonlyMap<string, Pages>>(new Map());
/** Keeps one person's answer for the next page of this document. */
const remember = (key: string, pages: Pages) =>
  Effect.sync(() => MutableRef.update(answered, (current) => new Map(current).set(key, pages)));
registerSessionScopedReset(
  accessPagesCache.invalidateAll.pipe(Effect.andThen(Effect.sync(() => MutableRef.set(answered, new Map())))),
);

/** The pages the navigation offers; none until the Shell answered (server rendering offers none). */
export const useAccessAdministrationPages = (principalId: string | undefined, tenantId: string): Pages => {
  const key = `${principalId ?? ''}\n${tenantId}`;
  const known = MutableRef.get(answered).get(key) ?? [];
  const [answer, setAnswer] = useState(() => ({ key, pages: known }));
  useEffect(() => {
    const fiber = browserRuntime.runFork(
      accessPagesCache.get(key).pipe(
        Effect.orElseSucceed((): Pages => []),
        Effect.tap((pages) => remember(key, pages)),
        Effect.tap((pages) => Effect.sync(() => setAnswer({ key, pages }))),
      ),
    );
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [key]);
  return answer.key === key ? answer.pages : known;
};
