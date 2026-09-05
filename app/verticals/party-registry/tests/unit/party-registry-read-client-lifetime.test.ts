// @effect-diagnostics asyncFunction:off -- node:test takes an async callback to await the run seams below. remove-when: the shared itEffect/itLayer harness lands (audit B2)
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { CounterpartyReadApi } from '../../shared/apis/counterparty-read.ts';
import { CounterpartyRoleHistoryApi } from '../../shared/apis/counterparty-role-history.ts';
import { PartyMatchApi } from '../../shared/apis/party-match.ts';
import type { CounterpartyRef } from '../../shared/resources/counterparty.ts';
import type { PartyCandidate } from '../../shared/domain/identity-contracts.ts';

interface RecordedRequest {
  readonly authorization: string;
  readonly correlationId: string;
  readonly url: string;
}

/**
 * Construction is counted, not inferred: `HttpApiClient` reflects the API — reading `groups` exactly
 * once — for every client it builds. Installed before the client modules are imported, which is why
 * they are reached through `import()` below rather than hoisted imports.
 */
const reflections = { counterpartyRead: 0, counterpartyRoleHistory: 0, partyMatch: 0 };
const countReflections = (api: { groups: unknown }, key: keyof typeof reflections) => {
  const { groups } = api;
  Object.defineProperty(api, 'groups', {
    configurable: true,
    get: () => {
      reflections[key] += 1;
      return groups;
    },
  });
};
countReflections(CounterpartyReadApi, 'counterpartyRead');
countReflections(CounterpartyRoleHistoryApi, 'counterpartyRoleHistory');
countReflections(PartyMatchApi, 'partyMatch');

const counterpartyRef: CounterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId: '20000000-0000-4000-8000-000000000001',
};

const candidate: PartyCandidate = {
  evidenceRefs: ['registry:verified:entry-42'],
  officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
  partyType: 'ORGANIZATION',
  provenance: { method: 'OFFICIAL_RECORD', source: 'verified-register' },
  validFrom: '2024-01-01T00:00:00.000Z',
};

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

const withShellLocation = async (body: () => Promise<void>) => {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en/party-registry' },
  });
  try {
    await body();
  } finally {
    globalThis.fetch = originalFetch;
    if (location === undefined) {
      Reflect.deleteProperty(globalThis, 'location');
    } else {
      Object.defineProperty(globalThis, 'location', location);
    }
  }
};

const clients = () =>
  Promise.all([
    import('../../src/api/counterparty-read-client.ts'),
    import('../../src/api/counterparty-role-history-client.ts'),
    import('../../src/api/party-match-client.ts'),
  ]);

/**
 * Reuse is proved by the build counter, never by transport inheritance. Inheritance is the bug this
 * test rejects: a client built inside its first caller keeps that caller's context — its
 * `FetchHttpClient.Fetch` above all — merged under every later request.
 */
test('builds each Party registry read client once while retaining nothing from any caller', async () => {
  const injectedFirst: RecordedRequest[] = [];
  const ambient: RecordedRequest[] = [];
  const injectedLater: RecordedRequest[] = [];
  let reflectionsBeforeAnyCall = { ...reflections };

  await withShellLocation(async () => {
    globalThis.fetch = recorder(ambient);
    const [read, history, match] = await clients();
    reflectionsBeforeAnyCall = { ...reflections };

    await Effect.runPromise(
      // Injects a transport of its own. Under the bug, this is the call whose context gets captured.
      read
        .executeCounterpartyReadWithAuthorization(
          { counterpartyRef },
          Redacted.make('Bearer first'),
          'correlation-first',
        )
        .pipe(
          Effect.result,
          Effect.provideService(FetchHttpClient.Fetch, recorder(injectedFirst)),
          // Injects nothing: it must reach the ambient default, never the first call's recorder.
          Effect.andThen(
            history
              .executeCounterpartyRoleHistoryWithAuthorization(
                { counterpartyRef },
                Redacted.make('Bearer second'),
                'correlation-second',
              )
              .pipe(Effect.result),
          ),
          Effect.andThen(
            Effect.all(
              [
                read
                  .executeCounterpartyReadWithAuthorization(
                    { counterpartyRef },
                    Redacted.make('Bearer a'),
                    'correlation-a',
                  )
                  .pipe(Effect.result),
                history
                  .executeCounterpartyRoleHistoryWithAuthorization(
                    { counterpartyRef },
                    Redacted.make('Bearer b'),
                    'correlation-b',
                    { baseUrl: 'https://party.example/party-registry-api' },
                  )
                  .pipe(Effect.result),
                match
                  .executePartyMatchWithAuthorization(
                    { candidate },
                    Redacted.make('Bearer c'),
                    'correlation-c',
                    {
                      baseUrl: 'https://other.example/party-registry-api',
                    },
                  )
                  .pipe(Effect.result),
              ],
              { concurrency: 'unbounded' },
            ).pipe(Effect.provideService(FetchHttpClient.Fetch, recorder(injectedLater))),
          ),
        ),
    );
  });

  // Reuse: five requests, three clients, each built before any call ran and never rebuilt.
  assert.deepEqual(reflectionsBeforeAnyCall, {
    counterpartyRead: 1,
    counterpartyRoleHistory: 1,
    partyMatch: 1,
  });
  assert.deepEqual(reflections, {
    counterpartyRead: 1,
    counterpartyRoleHistory: 1,
    partyMatch: 1,
  });

  // No inheritance: the injecting call took its own transport and only its own request.
  assert.deepEqual(injectedFirst, [
    {
      authorization: 'Bearer first',
      correlationId: 'correlation-first',
      url: 'https://shell.example/party-registry-api/reads/counterparty-read',
    },
  ]);

  // Absent injection uses the ordinary default, not whatever the first caller happened to provide.
  assert.deepEqual(ambient, [
    {
      authorization: 'Bearer second',
      correlationId: 'correlation-second',
      url: 'https://shell.example/party-registry-api/reads/counterparty-role-history',
    },
  ]);

  // Three concurrent calls on three shared clients each keep their own base URL and credential.
  assert.deepEqual(injectedLater.toSorted(byCorrelationId), [
    {
      authorization: 'Bearer a',
      correlationId: 'correlation-a',
      url: 'https://shell.example/party-registry-api/reads/counterparty-read',
    },
    {
      authorization: 'Bearer b',
      correlationId: 'correlation-b',
      url: 'https://party.example/party-registry-api/reads/counterparty-role-history',
    },
    {
      authorization: 'Bearer c',
      correlationId: 'correlation-c',
      url: 'https://other.example/party-registry-api/reads/party-match',
    },
  ]);
});

/** The budget is whole-operation: a response that never arrives and a body that never finishes both end it. */
test('bounds a stalled fetch and a stalled response body with a typed TimeoutError', async () => {
  const aborted: string[] = [];
  let stalledBody: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stalledFetch: typeof globalThis.fetch = (_input, init) => {
    // A response that never arrives, settled only by the abort the budget triggers.
    const stalled = Promise.withResolvers<Response>();
    init?.signal?.addEventListener('abort', () => {
      aborted.push('fetch');
      stalled.reject(new DOMException('aborted', 'AbortError'));
    });
    return stalled.promise;
  };

  const stalledBodyFetch: typeof globalThis.fetch = (_input, init) => {
    init?.signal?.addEventListener('abort', () => aborted.push('body'));
    // Status 200 with a body that never closes: the decode, not the response, is what stalls.
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stalledBody = controller;
      },
    });
    return Promise.resolve(
      new Response(body, { headers: { 'content-type': 'application/json' }, status: 200 }),
    );
  };

  await withShellLocation(async () => {
    const [read, history] = await clients();

    const stalledFetchOutcome = await Effect.runPromise(
      read
        .executeCounterpartyReadWithAuthorization(
          { counterpartyRef },
          Redacted.make('Bearer stalled-fetch'),
          'correlation-stalled-fetch',
          { timeoutMs: 25 },
        )
        .pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, stalledFetch)),
    );
    assert.ok('failure' in stalledFetchOutcome);
    assert.equal(stalledFetchOutcome.failure._tag, 'TimeoutError');

    const stalledBodyOutcome = await Effect.runPromise(
      history
        .executeCounterpartyRoleHistoryWithAuthorization(
          { counterpartyRef },
          Redacted.make('Bearer stalled-body'),
          'correlation-stalled-body',
          { timeoutMs: 25 },
        )
        .pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, stalledBodyFetch)),
    );
    assert.ok('failure' in stalledBodyOutcome);
    assert.equal(stalledBodyOutcome.failure._tag, 'TimeoutError');
    stalledBody?.close();
  });

  // The budget interrupts the in-flight request rather than leaving it running past the deadline.
  assert.deepEqual(aborted.toSorted(), ['body', 'fetch']);

  // Timing out a read leaves no side effect to reconcile, and nothing here retries one.
  assert.deepEqual(reflections, {
    counterpartyRead: 1,
    counterpartyRoleHistory: 1,
    partyMatch: 1,
  });
});
