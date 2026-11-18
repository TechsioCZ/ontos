// @rstest-environment happy-dom
import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import { browserNetwork } from '@app/shared-contracts/testing/http-double';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { beforeAll, beforeEach, expect, it } from 'effect-rstest';

import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';

const searchUrl = '/shell-super-app-api/module-api/example-owner/build/example-api/search/records';
const readUrl = '/shell-super-app-api/module-api/example-owner/build/example-api/reads/records';
const actionUrl = '/shell-super-app-api/module-api/example-owner/build/example-api/actions/change';
const received: string[] = [];
let sequence = 0;
const receiveModuleRequest = Effect.gen(function* receiveModuleRequestEffect() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  received.push(new URL(request.url, 'http://shell.test').pathname);
  sequence += 1;
  return HttpServerResponse.jsonUnsafe({ sequence });
});
const network = browserNetwork(
  HttpRouter.add('POST', searchUrl, receiveModuleRequest),
  HttpRouter.add('POST', readUrl, receiveModuleRequest),
  HttpRouter.add('POST', actionUrl, receiveModuleRequest),
);
const request = { body: JSON.stringify({ query: 'current' }), method: 'POST' };
const SequenceJson = Schema.fromJsonString(Schema.Struct({ sequence: Schema.Int }));
const readSequence = (url: string, init: RequestInit) =>
  Effect.promise(() => globalThis.fetch(url, init)).pipe(
    Effect.flatMap((response) => Effect.promise(() => response.text())),
    Effect.flatMap(Schema.decodeUnknownEffect(SequenceJson)),
  );

beforeAll(() => {
  installBrowserRequestCache();
});
beforeEach(() => {
  received.length = 0;
  sequence = 0;
});

it.live('never caches or joins identical module search requests', () =>
  Effect.gen(function* freshModuleSearch() {
    yield* clearBrowserRequestCache;
    const first = yield* readSequence(searchUrl, request);
    const second = yield* readSequence(searchUrl, request);
    expect(first).toEqual({ sequence: 1 });
    expect(second).toEqual({ sequence: 2 });
    expect(received).toHaveLength(2);
    received.length = 0;
    yield* Effect.promise(() =>
      Promise.all([globalThis.fetch(searchUrl, request), globalThis.fetch(searchUrl, request)]),
    );
    expect(received).toHaveLength(2);
  }).pipe(Effect.provide(network)),
);

it.live('an explicit no-store owner target read bypasses stored answers without purging ordinary reads', () =>
  Effect.gen(function* freshOwnerTargetRead() {
    yield* clearBrowserRequestCache;
    const first = yield* readSequence(readUrl, request);
    const retained = yield* readSequence(readUrl, request);
    expect(retained).toEqual(first);
    expect(received).toHaveLength(1);
    const second = yield* readSequence(readUrl, { ...request, cache: 'no-store' });
    const third = yield* readSequence(readUrl, { ...request, cache: 'no-store' });
    expect(second).toEqual({ sequence: 2 });
    expect(third).toEqual({ sequence: 3 });
    expect(received).toHaveLength(3);
    expect(yield* readSequence(readUrl, request)).toEqual(first);
    expect(received).toHaveLength(3);
  }).pipe(Effect.provide(network)),
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
    expect(received).toHaveLength(3);
  }).pipe(Effect.provide(network)),
);

it.live('a no-store action still performs ordinary write invalidation', () =>
  Effect.gen(function* noStoreDoesNotHideWrites() {
    yield* clearBrowserRequestCache;
    expect(yield* readSequence(readUrl, request)).toEqual({ sequence: 1 });
    yield* Effect.promise(() =>
      globalThis.fetch(actionUrl, {
        ...request,
        headers: { 'cache-control': 'no-store' },
      }),
    );
    expect(yield* readSequence(readUrl, request)).toEqual({ sequence: 3 });
    expect(received).toHaveLength(3);
  }).pipe(Effect.provide(network)),
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
      expect(received).toHaveLength(2);
    } finally {
      globalThis.removeEventListener(moduleWriteEvent, onWrite);
    }
  }).pipe(Effect.provide(network)),
);
