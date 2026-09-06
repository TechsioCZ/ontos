// @effect-diagnostics asyncFunction:off -- node:test takes an async callback to await the one run seam below. remove-when: the shared itEffect/itLayer harness lands (audit B2)
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Redacted, Result } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { PartyDetailApi } from '../../shared/apis/party-detail.ts';
import type { PartyRef } from '../../shared/resources/party.ts';

interface RecordedRequest {
  readonly authorization: string;
  readonly correlationId: string;
  readonly url: string;
}

/**
 * Construction is counted, not inferred. `HttpApiClient` reflects the API — reading `groups` exactly
 * once — for every client it builds, so this getter counts builds directly, independently of any
 * context a call happens to carry. Installed before the client module is imported, which is why that
 * module is reached through `import()` below rather than a hoisted `import`.
 */
let apiReflections = 0;
const partyDetailGroups = PartyDetailApi.groups;
Object.defineProperty(PartyDetailApi, 'groups', {
  configurable: true,
  get: () => {
    apiReflections += 1;
    return partyDetailGroups;
  },
});

const partyRef = (suffix: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId: `10000000-0000-4000-8000-00000000000${suffix}`,
  resourceType: 'party.registry.party',
  tenantId: '20000000-0000-4000-8000-000000000001',
});

const recorder =
  (recorded: RecordedRequest[]): typeof globalThis.fetch =>
  (input, init) => {
    const headers = new Headers(init?.headers);
    recorded.push({
      authorization: headers.get('authorization') ?? '',
      correlationId: headers.get('x-correlation-id') ?? '',
      url: String(input),
    });
    // 503 is a declared typed failure, so each call completes without needing a decodable body.
    return Promise.resolve(new Response(null, { status: 503 }));
  };

const byCorrelationId = (left: RecordedRequest, right: RecordedRequest) =>
  left.correlationId.localeCompare(right.correlationId);

const detailUrl = (origin: string) => `${origin}/party-registry-api/reads/party-detail`;

/**
 * One test, because every claim reads the same piece of process state: this module owns exactly one
 * typed client for the life of the process.
 *
 * Reuse is proved by the build counter, never by transport inheritance. Inheritance is the bug this
 * test exists to reject: a client built inside its first caller keeps that caller's context — its
 * `FetchHttpClient.Fetch` above all — merged under every later request, so a later call that injects
 * nothing would silently ride the first caller's transport. A shared client must instead retain
 * nothing: a call that injects a transport gets exactly that one, and a call that injects none falls
 * through to the ordinary `globalThis.fetch` default.
 */
test('builds the Party detail client once while retaining nothing from any caller', async () => {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalFetch = globalThis.fetch;
  const injectedFirst: RecordedRequest[] = [];
  const ambient: RecordedRequest[] = [];
  const injectedLater: RecordedRequest[] = [];
  const interleaved = [
    { authorization: 'Bearer a', baseUrl: undefined, correlationId: 'correlation-a' },
    {
      authorization: 'Bearer b',
      baseUrl: 'https://party.example/party-registry-api',
      correlationId: 'correlation-b',
    },
    {
      authorization: 'Bearer c',
      baseUrl: 'https://other.example/party-registry-api',
      correlationId: 'correlation-c',
    },
  ] as const;

  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en/party-registry' },
  });
  globalThis.fetch = recorder(ambient);
  let reflectionsBeforeAnyCall = 0;
  try {
    const { executePartyDetailWithAuthorization } =
      await import('../../src/api/party-detail-client.ts');
    reflectionsBeforeAnyCall = apiReflections;

    await Effect.runPromise(
      // Injects a transport of its own. Under the bug, this is the call whose context gets captured.
      executePartyDetailWithAuthorization(
        { partyRef: partyRef('1') },
        Redacted.make('Bearer first'),
        'correlation-first',
        {},
      ).pipe(
        Effect.result,
        Effect.provideService(FetchHttpClient.Fetch, recorder(injectedFirst)),
        // Injects nothing: it must reach the ambient default, never the first call's recorder.
        Effect.andThen(
          executePartyDetailWithAuthorization(
            { partyRef: partyRef('2') },
            Redacted.make('Bearer second'),
            'correlation-second',
            {},
          ).pipe(Effect.result),
        ),
        Effect.andThen(
          Effect.all(
            interleaved.map((call, index) =>
              executePartyDetailWithAuthorization(
                { partyRef: partyRef(String(index + 3)) },
                Redacted.make(call.authorization),
                call.correlationId,
                call.baseUrl === undefined ? {} : { baseUrl: call.baseUrl },
              ).pipe(Effect.result),
            ),
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

  // Reuse: five requests, one client. The client is built before any call runs and never rebuilt,
  // so no call can be the one whose context a later call inherits.
  assert.equal(reflectionsBeforeAnyCall, 1);
  assert.equal(apiReflections, 1);

  // No inheritance: the injecting call took its own transport and only its own request.
  assert.deepEqual(injectedFirst, [
    {
      authorization: 'Bearer first',
      correlationId: 'correlation-first',
      url: detailUrl('https://shell.example'),
    },
  ]);

  // Absent injection uses the ordinary default, not whatever the first caller happened to provide.
  assert.deepEqual(ambient, [
    {
      authorization: 'Bearer second',
      correlationId: 'correlation-second',
      url: detailUrl('https://shell.example'),
    },
  ]);

  // Per-call injection wins on that same shared client, and three concurrent calls each keep their
  // own base URL and their own credential.
  assert.deepEqual(injectedLater.toSorted(byCorrelationId), [
    {
      authorization: 'Bearer a',
      correlationId: 'correlation-a',
      url: detailUrl('https://shell.example'),
    },
    {
      authorization: 'Bearer b',
      correlationId: 'correlation-b',
      url: detailUrl('https://party.example'),
    },
    {
      authorization: 'Bearer c',
      correlationId: 'correlation-c',
      url: detailUrl('https://other.example'),
    },
  ]);
});

/**
 * Runs one Read against a transport that never completes, on a budget short enough to be a test.
 * An absolute `baseUrl` keeps these cases off `location`, so only the deadline is under test.
 */
const stalledDetail = async (transport: typeof globalThis.fetch) => {
  const { executePartyDetailWithAuthorization } =
    await import('../../src/api/party-detail-client.ts');
  return await Effect.runPromise(
    executePartyDetailWithAuthorization(
      { partyRef: partyRef('9') },
      Redacted.make('Bearer slow'),
      'correlation-slow',
      { baseUrl: 'https://slow.example/party-registry-api', timeoutMs: 25 },
    ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, transport)),
  );
};

const outcome = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure._tag : 'Success';

/**
 * A budget is only a deadline if it ends the request as well as the Effect. A timeout that returned
 * while the socket stayed open would leak the connection and, on a write, leave the caller unable to
 * tell an abandoned attempt from a rejected one.
 */
test('ends a stalled connection with a typed TimeoutError, aborting it and never retrying', async () => {
  let attempts = 0;
  let aborted = false;

  const result = await stalledDetail((_input, init) => {
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
    return connection.promise;
  });

  // The deadline is a typed failure, not a defect, and it fired once: expiry interrupts this Read
  // rather than re-issuing it.
  assert.equal(outcome(result), 'TimeoutError');
  assert.equal(aborted, true);
  assert.equal(attempts, 1);
  // The budget is per call, so it cannot have rebuilt the process-wide client.
  assert.equal(apiReflections, 1);
});

/**
 * The headers arriving fast proves nothing: `execute` still has to read and decode the body. The
 * budget is applied outside `execute` precisely so a response that starts but never finishes is
 * bounded too.
 */
test('holds the budget across the response body, aborting a stalled read', async () => {
  let aborted = false;

  const result = await stalledDetail((_input, init) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                controller.error(new Error('aborted'));
              },
              { once: true },
            );
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    ),
  );

  // A 200 whose body never arrives times out like any other stall, and the body read is aborted.
  assert.equal(outcome(result), 'TimeoutError');
  assert.equal(aborted, true);
  assert.equal(apiReflections, 1);
});
