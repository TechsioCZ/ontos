// @effect-diagnostics asyncFunction:off -- node:test takes an async callback to await the run seams below.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Result } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { partyRegistryFoundationApi } from '../../shared/api.ts';
import {
  partyRegistryCommandRecoveryApi,
  partyRegistryCommandsApi,
} from '../../shared/command-api.ts';

/**
 * Builds are counted, not inferred: `HttpApiClient` reflects an API — reading `groups` exactly once
 * — for every client it builds. The getters are installed before the client modules are imported,
 * which is why those modules are reached through `import()` inside the tests.
 */
const reflections = { commands: 0, foundation: 0, recovery: 0 };
const countGroups = (api: { groups: unknown }, key: keyof typeof reflections) => {
  const { groups } = api;
  Object.defineProperty(api, 'groups', {
    configurable: true,
    get: () => {
      reflections[key] += 1;
      return groups;
    },
  });
};
countGroups(partyRegistryCommandsApi, 'commands');
countGroups(partyRegistryCommandRecoveryApi, 'recovery');
countGroups(partyRegistryFoundationApi, 'foundation');

interface RecordedRequest {
  readonly authorization: string;
  readonly correlationId: string;
  readonly url: string;
}

const recorder =
  (recorded: RecordedRequest[]): typeof globalThis.fetch =>
  (input, init) => {
    const request = new Request(input, init);
    recorded.push({
      authorization: request.headers.get('authorization') ?? '',
      correlationId: request.headers.get('x-correlation-id') ?? '',
      url: request.url,
    });
    // 503 needs no decodable body; every assertion below is about the request that was issued.
    return Promise.resolve(new Response(null, { status: 503 }));
  };

const byCorrelationId = (left: RecordedRequest, right: RecordedRequest) =>
  left.correlationId.localeCompare(right.correlationId);

const rebuildUrl = (origin: string) =>
  `${origin}/party-registry-api/party-registry/actions/request-search-rebuild`;

test('builds each Party command client once while retaining nothing from any caller', async () => {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalFetch = globalThis.fetch;
  const injectedFirst: RecordedRequest[] = [];
  const ambient: RecordedRequest[] = [];
  const injectedLater: RecordedRequest[] = [];

  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en/party-registry' },
  });
  globalThis.fetch = recorder(ambient);
  let buildsBeforeAnyCall = { commands: 0, recovery: 0 };
  try {
    const { requestSearchRebuildWithAuthorization, resolvePartyCommandCommitWithAuthorization } =
      await import('../../src/api/party-command-client.ts');
    buildsBeforeAnyCall = { commands: reflections.commands, recovery: reflections.recovery };

    await Effect.runPromise(
      // Injects a transport of its own. Under the bug, this is the call whose context gets captured.
      requestSearchRebuildWithAuthorization({}, 'Bearer first', {
        correlationId: 'correlation-first',
        idempotencyKey: 'rebuild-first',
      }).pipe(
        Effect.result,
        Effect.provideService(FetchHttpClient.Fetch, recorder(injectedFirst)),
        // Injects nothing: it must reach the ambient default, never the first call's recorder.
        Effect.andThen(
          requestSearchRebuildWithAuthorization({}, 'Bearer second', {
            correlationId: 'correlation-second',
            idempotencyKey: 'rebuild-second',
          }).pipe(Effect.result),
        ),
        Effect.andThen(
          Effect.all(
            [
              requestSearchRebuildWithAuthorization({}, 'Bearer a', {
                correlationId: 'correlation-a',
                idempotencyKey: 'rebuild-a',
              }).pipe(Effect.result),
              requestSearchRebuildWithAuthorization({}, 'Bearer b', {
                baseUrl: 'https://party.example/party-registry-api',
                correlationId: 'correlation-b',
                idempotencyKey: 'rebuild-b',
              }).pipe(Effect.result),
              resolvePartyCommandCommitWithAuthorization(
                { invocationId: '10000000-0000-4000-8000-000000000001' },
                'Bearer c',
                {
                  baseUrl: 'https://other.example/party-registry-api',
                  correlationId: 'correlation-c',
                },
              ).pipe(Effect.result),
            ],
            { concurrency: 'unbounded' },
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, recorder(injectedLater))),
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

  // Reuse: five requests across two APIs, one client each, both built before any call runs.
  assert.deepEqual(buildsBeforeAnyCall, { commands: 1, recovery: 1 });
  assert.equal(reflections.commands, 1);
  assert.equal(reflections.recovery, 1);

  // No inheritance: the injecting call took its own transport and only its own request.
  assert.deepEqual(injectedFirst, [
    {
      authorization: 'Bearer first',
      correlationId: 'correlation-first',
      url: rebuildUrl('https://shell.example'),
    },
  ]);

  // Absent injection uses the ordinary default, not whatever the first caller happened to provide.
  assert.deepEqual(ambient, [
    {
      authorization: 'Bearer second',
      correlationId: 'correlation-second',
      url: rebuildUrl('https://shell.example'),
    },
  ]);

  // Concurrent commands and a recovery keep their own credential and their own base URL.
  assert.deepEqual(injectedLater.toSorted(byCorrelationId), [
    {
      authorization: 'Bearer a',
      correlationId: 'correlation-a',
      url: rebuildUrl('https://shell.example'),
    },
    {
      authorization: 'Bearer b',
      correlationId: 'correlation-b',
      url: rebuildUrl('https://party.example'),
    },
    {
      authorization: 'Bearer c',
      correlationId: 'correlation-c',
      url: 'https://other.example/party-registry-api/party-registry/action-commits/resolve',
    },
  ]);
});

/** A transport that settles only on abort: nothing but the caller's deadline can end the call. */
const stalledTransport =
  (record: { aborted: boolean; attempts: number }): typeof globalThis.fetch =>
  (_input, init) => {
    record.attempts += 1;
    const connection = Promise.withResolvers<Response>();
    init?.signal?.addEventListener(
      'abort',
      () => {
        record.aborted = true;
        connection.reject(new Error('aborted'));
      },
      { once: true },
    );
    return connection.promise;
  };

test('a stalled command fails with a typed timeout and never resubmits the write', async () => {
  const { requestSearchRebuildWithAuthorization } =
    await import('../../src/api/party-command-client.ts');
  const stalled = { aborted: false, attempts: 0 };

  const outcome = await Effect.runPromise(
    requestSearchRebuildWithAuthorization({}, 'Bearer stalled', {
      baseUrl: 'https://party.example/party-registry-api',
      correlationId: 'stalled',
      idempotencyKey: 'rebuild-stalled',
      timeoutMs: 25,
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, stalledTransport(stalled))),
  );

  assert.ok(Result.isFailure(outcome));
  // A timed-out write is unknown, not failed: it stays distinguishable from every declared problem,
  // it ends the attempt rather than leaking it, and it never re-issues the side effect.
  assert.equal(outcome.failure._tag, 'TimeoutError');
  assert.deepEqual(stalled, { aborted: true, attempts: 1 });
});

test('readiness shares one client, keeps its request-context headers and honours its budget', async () => {
  const { getPartyRegistryReadiness } = await import('../../src/api/party-registry-client.ts');
  const requests: Request[] = [];
  const capture: typeof globalThis.fetch = (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response(null, { status: 503 }));
  };
  const stalled = { aborted: false, attempts: 0 };

  const probed = await Effect.runPromise(
    getPartyRegistryReadiness({
      baseUrl: 'https://party.example/party-registry-api',
      locale: 'cs-CZ',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, capture)),
  );
  const timedOut = await Effect.runPromise(
    getPartyRegistryReadiness({
      baseUrl: 'https://party.example/party-registry-api',
      timeoutMs: 25,
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, stalledTransport(stalled))),
  );

  assert.equal(reflections.foundation, 1);
  assert.ok(Result.isFailure(probed));
  const [request] = requests;
  assert.ok(request);
  assert.equal(request.url, 'https://party.example/party-registry-api/party-registry/readiness');
  assert.equal(request.headers.get('accept-language'), 'cs-CZ');
  // Unchanged from the construction-time request context: the client's own tracer owns this header
  // and overwrites the caller's value, so only its presence and shape are the client's contract.
  assert.match(request.headers.get('traceparent') ?? '', /^00-[\da-f]{32}-[\da-f]{16}-0[01]$/u);
  assert.ok(Result.isFailure(timedOut));
  assert.equal(timedOut.failure._tag, 'TimeoutError');
  assert.deepEqual(stalled, { aborted: true, attempts: 1 });
});
