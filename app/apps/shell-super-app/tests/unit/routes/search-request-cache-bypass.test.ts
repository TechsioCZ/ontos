import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';

const platformFetch = rstest.fn<typeof globalThis.fetch>();
const originalFetch = globalThis.fetch;
const searchUrl = '/shell-super-app-api/module-api/example-owner/build/example-api/search/records';
const readUrl = '/shell-super-app-api/module-api/example-owner/build/example-api/reads/records';
const request = { body: JSON.stringify({ query: 'current' }), method: 'POST' };
const SequenceJson = Schema.fromJsonString(Schema.Struct({ sequence: Schema.Int }));
const readSequence = (url: string, init: RequestInit) =>
  Effect.promise(() => globalThis.fetch(url, init)).pipe(
    Effect.flatMap((response) => Effect.promise(() => response.text())),
    Effect.flatMap(Schema.decodeUnknownEffect(SequenceJson)),
  );

beforeAll(() => {
  globalThis.fetch = platformFetch;
  installBrowserRequestCache();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  platformFetch.mockReset();
  let sequence = 0;
  platformFetch.mockImplementation(() => {
    sequence += 1;
    return Promise.resolve(Response.json({ sequence }));
  });
});

it.live('never caches or joins identical module search requests', () =>
  Effect.gen(function* freshModuleSearch() {
    yield* clearBrowserRequestCache;
    const first = yield* readSequence(searchUrl, request);
    const second = yield* readSequence(searchUrl, request);
    expect(first).toEqual({ sequence: 1 });
    expect(second).toEqual({ sequence: 2 });
    expect(platformFetch).toHaveBeenCalledTimes(2);
    platformFetch.mockClear();
    yield* Effect.promise(() =>
      Promise.all([globalThis.fetch(searchUrl, request), globalThis.fetch(searchUrl, request)]),
    );
    expect(platformFetch).toHaveBeenCalledTimes(2);
  }),
);

it.live('an explicit no-store owner target read bypasses stored answers without purging ordinary reads', () =>
  Effect.gen(function* freshOwnerTargetRead() {
    yield* clearBrowserRequestCache;
    const first = yield* readSequence(readUrl, request);
    const retained = yield* readSequence(readUrl, request);
    expect(retained).toEqual(first);
    expect(platformFetch).toHaveBeenCalledTimes(1);
    const second = yield* readSequence(readUrl, { ...request, cache: 'no-store' });
    const third = yield* readSequence(readUrl, { ...request, cache: 'no-store' });
    expect(second).toEqual({ sequence: 2 });
    expect(third).toEqual({ sequence: 3 });
    expect(platformFetch).toHaveBeenCalledTimes(3);
    expect(yield* readSequence(readUrl, request)).toEqual(first);
    expect(platformFetch).toHaveBeenCalledTimes(3);
  }),
);

it.live('the public no-store transport header bypasses cached exact-target reads', () =>
  Effect.gen(function* freshOwnerHeader() {
    yield* clearBrowserRequestCache;
    expect(yield* readSequence(readUrl, request)).toEqual({ sequence: 1 });
    expect(yield* readSequence(readUrl, { ...request, headers: { 'cache-control': 'no-store' } })).toEqual({
      sequence: 2,
    });
    expect(yield* readSequence(readUrl, { ...request, headers: { 'cache-control': 'NO-STORE, max-age=0' } })).toEqual({
      sequence: 3,
    });
    expect(yield* readSequence(readUrl, request)).toEqual({ sequence: 1 });
    expect(platformFetch).toHaveBeenCalledTimes(3);
  }),
);

it.live('a no-store action still performs ordinary write invalidation', () =>
  Effect.gen(function* noStoreDoesNotHideWrites() {
    yield* clearBrowserRequestCache;
    expect(yield* readSequence(readUrl, request)).toEqual({ sequence: 1 });
    yield* Effect.promise(() =>
      globalThis.fetch('/shell-super-app-api/module-api/example-owner/build/example-api/actions/change', {
        ...request,
        headers: { 'cache-control': 'no-store' },
      }),
    );
    expect(yield* readSequence(readUrl, request)).toEqual({ sequence: 3 });
    expect(platformFetch).toHaveBeenCalledTimes(3);
  }),
);

it.live('search reads never become writes or invalidate unrelated cached owner data', () =>
  Effect.gen(function* noSearchMutation() {
    yield* clearBrowserRequestCache;
    let writes = 0;
    const onWrite = () => {
      writes += 1;
    };
    globalThis.addEventListener(moduleWriteEvent, onWrite);
    try {
      const cached = yield* readSequence(readUrl, request);
      yield* Effect.promise(() => globalThis.fetch(searchUrl, request));
      expect(yield* readSequence(readUrl, request)).toEqual(cached);
      expect(writes).toBe(0);
      expect(platformFetch).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.removeEventListener(moduleWriteEvent, onWrite);
    }
  }),
);
