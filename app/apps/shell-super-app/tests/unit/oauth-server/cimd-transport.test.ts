// @rstest-environment node
import { Effect, Fiber, Predicate, Result, Schema } from 'effect';
import { expect, it as test, rs } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { FetchHttpClient } from 'effect/unstable/http';

import {
  CIMD_FETCH_TIMEOUT_MS,
  CIMD_MAX_RESPONSE_BYTES,
  CimdFetchError,
  fetchClientMetadataResource,
} from '../../../api/auth/cimd-transport.workerd.ts';

const CLIENT = 'https://client.example/oauth/client.json';

test.effect('workerd CIMD rejects insecure URLs, literal addresses, localhost and credentials before fetching', () =>
  Effect.gen(function* rejectUnsafeUrls() {
    const fetch = rs.fn<typeof globalThis.fetch>();
    yield* Effect.forEach(
      [
        'http://client.example/client.json',
        'https://127.0.0.1/client.json',
        'https://2130706433/client.json',
        'https://0x7f000001/client.json',
        'https://[::1]/client.json',
        'https://[::ffff:127.0.0.1]/client.json',
        'https://localhost/client.json',
        'https://localhost./client.json',
        'https://private.localhost/client.json',
        'https://user:password@client.example/client.json',
        `${CLIENT}#fragment`,
      ],
      (url) =>
        fetchClientMetadataResource(url).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.result,
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(Result.isFailure(result)).toBe(true);
            }),
          ),
        ),
      { concurrency: 1 },
    );
    expect(fetch).not.toHaveBeenCalled();
  }),
);

test.effect('workerd CIMD preserves conditional headers, caps the response and forces manual redirects', () =>
  Effect.gen(function* requestHeaders() {
    const fetch = rs
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ client_id: CLIENT }, { headers: { etag: 'v1' } }));
    const response = yield* fetchClientMetadataResource(CLIENT, {
      headers: { 'if-none-match': 'v0' },
      redirect: 'follow',
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    expect(
      yield* Effect.promise(async () => await response.text()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
      ),
    ).toEqual({ client_id: CLIENT });
    expect(response.headers.get('etag')).toBe('v1');
    const [request, init] = fetch.mock.calls[0] ?? [];
    expect(request).toBeInstanceOf(Request);
    if (Schema.is(Schema.instanceOf(Request))(request)) {
      expect(request.headers.get('if-none-match')).toBe('v0');
    }
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  }),
);

test.effect('workerd CIMD passes a conditional 304 through without requiring a JSON body', () =>
  Effect.gen(function* notModified() {
    const fetch = rs
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { headers: { etag: 'v1' }, status: 304 }));
    const response = yield* fetchClientMetadataResource(CLIENT, { headers: { 'if-none-match': 'v1' } }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('v1');
  }),
);

test.effect('workerd CIMD refuses redirects, non-JSON, malformed JSON and declared oversized bodies', () =>
  Effect.forEach(
    [
      new Response(null, { headers: { location: 'https://elsewhere.example/metadata' }, status: 302 }),
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      new Response('{broken', { headers: { 'content-type': 'application/json' } }),
      new Response('{}', {
        headers: { 'content-length': String(CIMD_MAX_RESPONSE_BYTES + 1), 'content-type': 'application/json' },
      }),
    ],
    (response) =>
      Effect.gen(function* refuseResponse() {
        const fetch = rs.fn<typeof globalThis.fetch>().mockResolvedValue(response);
        const result = yield* Effect.result(
          fetchClientMetadataResource(CLIENT).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
      }),
    { concurrency: 1 },
  ),
);

test.effect('workerd CIMD cancels a streamed oversized body even without Content-Length', () =>
  Effect.gen(function* refuseOversizedStream() {
    const cancel = rs.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        controller.enqueue(new Uint8Array(CIMD_MAX_RESPONSE_BYTES + 1));
      },
    });
    const fetch = rs
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/json' } }));
    const result = yield* Effect.result(
      fetchClientMetadataResource(CLIENT).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain('too large');
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  }),
);

test.effect('workerd CIMD aborts a stalled fetch after five seconds', () =>
  Effect.gen(function* fetchTimeout() {
    // A pending native fetch Promise is the external transport seam under test.
    const pending = Promise.withResolvers<Response>();
    let requestedSignal: AbortSignal | undefined;
    const fetch = rs.fn<typeof globalThis.fetch>(async (_input, init) => {
      requestedSignal = init?.signal ?? undefined;
      const signal = requestedSignal;
      signal?.addEventListener(
        'abort',
        () => {
          const reason: unknown = signal.reason;
          pending.reject(Predicate.isError(reason) ? reason : new CimdFetchError({ message: 'fetch aborted' }));
        },
        { once: true },
      );
      return await pending.promise;
    });
    const result = yield* Effect.forkChild(
      Effect.result(fetchClientMetadataResource(CLIENT).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))),
      { startImmediately: true },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    yield* TestClock.adjust(CIMD_FETCH_TIMEOUT_MS);
    const outcome = yield* Fiber.join(result);
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure.message).toContain('timed out');
    }
    expect(requestedSignal?.aborted).toBe(true);
  }),
);

test.effect('workerd CIMD propagates caller cancellation', () =>
  Effect.gen(function* callerCancellation() {
    const controller = new AbortController();
    const pending = Promise.withResolvers<Response>();
    const fetch = rs.fn<typeof globalThis.fetch>(async (_input, init) => {
      const signal = init?.signal;
      signal?.addEventListener(
        'abort',
        () => {
          const reason: unknown = signal.reason;
          pending.reject(Predicate.isError(reason) ? reason : new CimdFetchError({ message: 'fetch aborted' }));
        },
        { once: true },
      );
      return await pending.promise;
    });
    const result = yield* Effect.forkChild(
      Effect.result(
        fetchClientMetadataResource(CLIENT, { signal: controller.signal }).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        ),
      ),
      { startImmediately: true },
    );
    controller.abort(new CimdFetchError({ message: 'caller cancelled' }));
    const outcome = yield* Fiber.join(result);
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure.message).toContain('caller cancelled');
    }
  }),
);
