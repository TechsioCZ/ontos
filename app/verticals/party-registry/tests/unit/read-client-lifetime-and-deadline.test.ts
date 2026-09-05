// @effect-diagnostics asyncFunction:off -- node:test takes an async callback to await the run seams below. remove-when: the shared itEffect/itLayer harness lands (audit B2)
import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Effect, Result } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { AresLookupApi } from '../../shared/apis/ares-lookup.ts';
import { PartyOfficialIdentifierDetailApi } from '../../shared/apis/party-official-identifier-detail.ts';
import { PartyOfficialIdentifierHistoryApi } from '../../shared/apis/party-official-identifier-history.ts';

interface RecordedRequest {
  readonly authorization: string;
  readonly correlationId: string;
  readonly url: string;
}

/**
 * Construction is counted, not inferred: `HttpApiClient` reads `groups` exactly once per client it
 * builds. The counters are installed before the client modules are imported, which is why those
 * modules are reached through `import()` below rather than a hoisted `import`.
 */
const apiReflections = { ares: 0, detail: 0, history: 0 };
const aresGroups = AresLookupApi.groups;
const detailGroups = PartyOfficialIdentifierDetailApi.groups;
const historyGroups = PartyOfficialIdentifierHistoryApi.groups;
Object.defineProperty(AresLookupApi, 'groups', {
  configurable: true,
  get: () => {
    apiReflections.ares += 1;
    return aresGroups;
  },
});
Object.defineProperty(PartyOfficialIdentifierDetailApi, 'groups', {
  configurable: true,
  get: () => {
    apiReflections.detail += 1;
    return detailGroups;
  },
});
Object.defineProperty(PartyOfficialIdentifierHistoryApi, 'groups', {
  configurable: true,
  get: () => {
    apiReflections.history += 1;
    return historyGroups;
  },
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

const identifierRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-official-identifier',
  tenantId: '20000000-0000-4000-8000-000000000001',
} as const;

const partyRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000002',
  resourceType: 'party.registry.party',
  tenantId: '20000000-0000-4000-8000-000000000001',
} as const;

const withLocation = async (run: () => Promise<void>) => {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en/party-registry' },
  });
  try {
    await run();
  } finally {
    if (location === undefined) {
      Reflect.deleteProperty(globalThis, 'location');
    } else {
      Object.defineProperty(globalThis, 'location', location);
    }
  }
};

const loadClients = () =>
  Promise.all([
    import('../../src/api/ares-lookup-client.ts'),
    import('../../src/api/party-official-identifier-detail-client.ts'),
    import('../../src/api/party-official-identifier-history-client.ts'),
  ]);

/**
 * Each module owns one typed client for the life of the process. Reuse is proved by the build
 * counter; a client built inside its first caller would keep that caller's context — its
 * `FetchHttpClient.Fetch` above all — merged under every later request, so a later call injecting
 * nothing would silently ride the first caller's transport.
 */
test('builds each read client once while retaining nothing from any caller', async () => {
  const injectedFirst: RecordedRequest[] = [];
  const ambient: RecordedRequest[] = [];
  const injectedLater: RecordedRequest[] = [];
  const originalFetch = globalThis.fetch;
  let reflectionsBeforeAnyCall = { ares: 0, detail: 0, history: 0 };

  globalThis.fetch = recorder(ambient);
  try {
    await withLocation(async () => {
      const [ares, detail, history] = await loadClients();
      reflectionsBeforeAnyCall = { ...apiReflections };

      await Effect.runPromise(
        // Injects a transport of its own. Under the bug, this is the call whose context is captured.
        ares
          .executeAresLookupWithAuthorization(
            { ico: '27074358' },
            'Bearer first',
            'correlation-first',
          )
          .pipe(
            Effect.result,
            Effect.provideService(FetchHttpClient.Fetch, recorder(injectedFirst)),
            // Injects nothing: it must reach the ambient default, never the first call's recorder.
            Effect.andThen(
              detail
                .executePartyOfficialIdentifierDetailWithAuthorization(
                  { officialIdentifierRef: identifierRef },
                  'Bearer second',
                  'correlation-second',
                )
                .pipe(Effect.result),
            ),
            Effect.andThen(
              Effect.all(
                [
                  ares
                    .executeAresLookupWithAuthorization(
                      { ico: '27074358' },
                      'Bearer a',
                      'correlation-a',
                    )
                    .pipe(Effect.result),
                  detail
                    .executePartyOfficialIdentifierDetailWithAuthorization(
                      { officialIdentifierRef: identifierRef },
                      'Bearer b',
                      'correlation-b',
                      { baseUrl: 'https://party.example/party-registry-api' },
                    )
                    .pipe(Effect.result),
                  history
                    .executePartyOfficialIdentifierHistoryWithAuthorization(
                      { partyRef },
                      'Bearer c',
                      'correlation-c',
                      { baseUrl: 'https://other.example/party-registry-api' },
                    )
                    .pipe(Effect.result),
                ],
                { concurrency: 'unbounded' },
              ).pipe(Effect.provideService(FetchHttpClient.Fetch, recorder(injectedLater))),
            ),
          ),
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Reuse: five requests, three clients, each built before any call runs and never rebuilt.
  assert.deepEqual(reflectionsBeforeAnyCall, { ares: 1, detail: 1, history: 1 });
  assert.deepEqual(apiReflections, { ares: 1, detail: 1, history: 1 });

  // No inheritance: the injecting call took its own transport and only its own request.
  assert.deepEqual(injectedFirst, [
    {
      authorization: 'Bearer first',
      correlationId: 'correlation-first',
      url: 'https://shell.example/party-registry-api/reads/ares-lookup',
    },
  ]);

  // Absent injection uses the ordinary default, not whatever the first caller happened to provide.
  assert.deepEqual(ambient, [
    {
      authorization: 'Bearer second',
      correlationId: 'correlation-second',
      url: 'https://shell.example/party-registry-api/reads/party-official-identifier-detail',
    },
  ]);

  // Three concurrent calls on those same shared clients each keep their own base URL and credential.
  assert.deepEqual(injectedLater.toSorted(byCorrelationId), [
    {
      authorization: 'Bearer a',
      correlationId: 'correlation-a',
      url: 'https://shell.example/party-registry-api/reads/ares-lookup',
    },
    {
      authorization: 'Bearer b',
      correlationId: 'correlation-b',
      url: 'https://party.example/party-registry-api/reads/party-official-identifier-detail',
    },
    {
      authorization: 'Bearer c',
      correlationId: 'correlation-c',
      url: 'https://other.example/party-registry-api/reads/party-official-identifier-history',
    },
  ]);
});

/**
 * The budget covers the whole operation, decode included, so a response whose body never arrives is
 * bounded exactly like a request that never connects — and the abandoned request is aborted rather
 * than left in flight.
 */
test('bounds a stalled read with a typed TimeoutError and aborts the request', async () => {
  const aborted: boolean[] = [];
  const stalledBody: typeof globalThis.fetch = (_input, init) => {
    init?.signal?.addEventListener('abort', () => aborted.push(true));
    // Headers arrive; the body never does, so only a whole-operation budget can end this call.
    return Promise.resolve(
      new Response(
        new ReadableStream({
          start: () => {
            /* never enqueues, never closes */
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    );
  };

  await withLocation(async () => {
    const [ares, , history] = await loadClients();
    const stalled = await Effect.runPromise(
      history
        .executePartyOfficialIdentifierHistoryWithAuthorization({ partyRef }, 'Bearer x', 'c-1', {
          timeoutMs: 25,
        })
        .pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, stalledBody)),
    );
    assert.ok(Result.isFailure(stalled));
    assert.ok(Cause.isTimeoutError(stalled.failure));
    assert.deepEqual(aborted, [true]);

    // A request that never connects is bounded by the same budget. `withResolvers` rather than a
    // hand-built Promise, so the pending connection is released once the assertions are done.
    const unconnected = Promise.withResolvers<Response>();
    const unreachable = await Effect.runPromise(
      ares
        .executeAresLookupWithAuthorization({ ico: '27074358' }, 'Bearer x', 'c-2', {
          timeoutMs: 25,
        })
        .pipe(
          Effect.result,
          Effect.provideService(FetchHttpClient.Fetch, () => unconnected.promise),
        ),
    );
    unconnected.resolve(new Response(null, { status: 503 }));
    assert.ok(Result.isFailure(unreachable));
    assert.ok(Cause.isTimeoutError(unreachable.failure));
  });
});
