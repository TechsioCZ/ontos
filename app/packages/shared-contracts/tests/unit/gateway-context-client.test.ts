// @effect-diagnostics asyncFunction:off -- node:test takes an async callback to await the one run seam per case below, and `fetch` itself is a promise-returning API. remove-when: the shared itEffect/itLayer harness lands (audit B2)
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Result } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { issueApiKeyGatewayContext, issueGatewayContext } from '../../src/gateway-context.ts';

interface RecordedRequest {
  readonly apiKey: string | null;
  readonly cookie: string | null;
  readonly url: string;
}

/** `Request` normalizes every `fetch` input shape to the absolute URL actually requested. */
const requestedUrl = (input: RequestInfo | URL) => new Request(input).url;

const recorder =
  (recorded: RecordedRequest[]): typeof globalThis.fetch =>
  async (input, init) => {
    const headers = new Headers(init?.headers);
    recorded.push({
      apiKey: headers.get('x-api-key'),
      cookie: headers.get('cookie'),
      url: requestedUrl(input),
    });
    // 503 is a declared typed failure, so each call completes without a decodable body.
    return new Response(null, { status: 503 });
  };

const byUrl = (left: RecordedRequest, right: RecordedRequest) => left.url.localeCompare(right.url);

const outcome = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure._tag : 'Success';

/**
 * The credential and the prefix belong to one call, never to the shared client. Interleaving calls
 * that carry different cookies proves neither is held between them, and a call that injects no
 * transport must reach the ambient default rather than an earlier caller's fetch.
 */
test('keeps each issuance cookie and base URL to its own request', async () => {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalFetch = globalThis.fetch;
  const injectedFirst: RecordedRequest[] = [];
  const ambient: RecordedRequest[] = [];
  const interleaved: RecordedRequest[] = [];

  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en' },
  });
  globalThis.fetch = recorder(ambient);
  try {
    await Effect.runPromise(
      // Injects a transport of its own; under first-call caching this is the context every later
      // call would inherit.
      issueGatewayContext({ audience: 'party-registry' }, { cookie: 'session=first' }).pipe(
        Effect.result,
        Effect.provideService(FetchHttpClient.Fetch, recorder(injectedFirst)),
        Effect.andThen(
          // Injects nothing: it must reach the ambient default, and carry no cookie at all.
          issueGatewayContext({ audience: 'party-registry' }).pipe(Effect.result),
        ),
        Effect.andThen(
          Effect.all(
            [
              issueGatewayContext(
                { audience: 'party-registry' },
                { baseUrl: 'https://a.example/shell-super-app-api', cookie: 'session=a' },
              ).pipe(Effect.result),
              issueGatewayContext(
                { audience: 'party-registry' },
                { baseUrl: 'https://b.example/shell-super-app-api', cookie: 'session=b' },
              ).pipe(Effect.result),
              issueApiKeyGatewayContext(
                'raw-key',
                { audience: 'party-registry' },
                {
                  baseUrl: 'https://c.example/shell-super-app-api',
                },
              ).pipe(Effect.result),
            ],
            { concurrency: 'unbounded' },
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, recorder(interleaved))),
        ),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (location === undefined) {
      Reflect.deleteProperty(globalThis, 'location');
    } else {
      Object.defineProperty(globalThis, 'location', location);
    }
  }

  assert.deepEqual(injectedFirst, [
    {
      apiKey: null,
      cookie: 'session=first',
      url: 'https://shell.example/shell-super-app-api/auth/gateway-context',
    },
  ]);

  // No inheritance, and no cookie invented for a caller that supplied none.
  assert.deepEqual(ambient, [
    {
      apiKey: null,
      cookie: null,
      url: 'https://shell.example/shell-super-app-api/auth/gateway-context',
    },
  ]);

  // Three concurrent calls on the one shared client, each with its own prefix and credential; the
  // API-key call still carries its typed endpoint header and never a cookie.
  assert.deepEqual(interleaved.toSorted(byUrl), [
    {
      apiKey: null,
      cookie: 'session=a',
      url: 'https://a.example/shell-super-app-api/auth/gateway-context',
    },
    {
      apiKey: null,
      cookie: 'session=b',
      url: 'https://b.example/shell-super-app-api/auth/gateway-context',
    },
    {
      apiKey: 'raw-key',
      cookie: null,
      url: 'https://c.example/shell-super-app-api/auth/api-key/gateway-context',
    },
  ]);
});

/**
 * A stalled issuance must end as a typed deadline, aborting the request rather than leaving the
 * caller to decide whether an assertion was minted. It is never re-issued here.
 */
test('ends a stalled issuance with a typed TimeoutError, aborting it and never retrying', async () => {
  let attempts = 0;
  let aborted = false;

  const result = await Effect.runPromise(
    issueGatewayContext(
      { audience: 'party-registry' },
      { baseUrl: 'https://slow.example/shell-super-app-api', timeoutMs: 25 },
    ).pipe(
      Effect.result,
      Effect.provideService(FetchHttpClient.Fetch, async (_input, init) => {
        attempts += 1;
        // Settles only on abort: nothing but the deadline can end this call.
        const connection = Promise.withResolvers<Response>();
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            connection.reject(new Error('aborted'));
          },
          { once: true },
        );
        return await connection.promise;
      }),
    ),
  );

  assert.equal(outcome(result), 'TimeoutError');
  assert.equal(aborted, true);
  assert.equal(attempts, 1);
});
