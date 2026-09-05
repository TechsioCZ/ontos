// @effect-diagnostics asyncFunction:off -- node:test takes an async callback to await the run seams below. remove-when: the shared itEffect/itLayer harness lands (audit B2)
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { CounterpartiesSearchApi } from '../../shared/apis/counterparties-search.ts';
import { DuplicateCandidateDetailApi } from '../../shared/apis/duplicate-candidate-detail.ts';
import { PartiesSearchApi } from '../../shared/apis/parties-search.ts';
import type { DuplicateCandidateDetailRequest } from '../../shared/apis/duplicate-candidate-detail.ts';

interface RecordedRequest {
  readonly authorization: string;
  readonly correlationId: string;
  readonly url: string;
}

/**
 * Construction is counted, not inferred: `HttpApiClient` reads `groups` exactly once per client it
 * builds, so these getters count builds directly. Installed before the client modules are imported,
 * which is why those modules are reached through `import()` below rather than hoisted imports.
 */
const countReflections = (api: { groups: unknown }): (() => number) => {
  let reflections = 0;
  const groups = api.groups;
  Object.defineProperty(api, 'groups', {
    configurable: true,
    get: () => {
      reflections += 1;
      return groups;
    },
  });
  return () => reflections;
};

const counterpartiesReflections = countReflections(CounterpartiesSearchApi);
const partiesReflections = countReflections(PartiesSearchApi);
const duplicateReflections = countReflections(DuplicateCandidateDetailApi);

const caseRef = (suffix: string): DuplicateCandidateDetailRequest['caseRef'] => ({
  moduleId: 'party.registry',
  resourceId: `10000000-0000-4000-8000-00000000000${suffix}`,
  resourceType: 'party.registry.duplicate-candidate-case',
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

const withStubbedLocation = async (run: () => Promise<void>): Promise<void> => {
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

const counterpartiesUrl = (origin: string) =>
  `${origin}/party-registry-api/party.registry/search/counterparties`;
const partiesUrl = (origin: string) => `${origin}/party-registry-api/party.registry/search/parties`;
const duplicateUrl = (origin: string) =>
  `${origin}/party-registry-api/reads/duplicate-candidate-detail`;

/**
 * One test per claim family, over the same process state: each module owns exactly one typed client
 * for the life of the process, and that client retains nothing from whichever caller ran first.
 * Inheritance is the bug this rejects — a client built inside its first caller keeps that caller's
 * `FetchHttpClient.Fetch` merged under every later request.
 */
test('builds each search and duplicate client once while retaining nothing from any caller', async () => {
  const originalFetch = globalThis.fetch;
  const injectedFirst: RecordedRequest[] = [];
  const ambient: RecordedRequest[] = [];
  const injectedLater: RecordedRequest[] = [];

  globalThis.fetch = recorder(ambient);
  let reflectionsBeforeAnyCall: readonly number[] = [];
  await withStubbedLocation(async () => {
    try {
      const [
        { loadCounterpartiesClientWithAuthorization },
        { loadPartiesClientWithAuthorization },
        { executeDuplicateCandidateDetailWithAuthorization },
      ] = await Promise.all([
        import('../../src/api/counterparties-search-client.ts'),
        import('../../src/api/parties-search-client.ts'),
        import('../../src/api/duplicate-candidate-detail-client.ts'),
      ]);
      reflectionsBeforeAnyCall = [
        counterpartiesReflections(),
        partiesReflections(),
        duplicateReflections(),
      ];

      await Effect.runPromise(
        // Injects a transport of its own. Under the bug, this is the call whose context gets captured.
        loadCounterpartiesClientWithAuthorization(
          { query: 'Example' },
          'Bearer first',
          'correlation-first',
          {},
        ).pipe(
          Effect.result,
          Effect.provideService(FetchHttpClient.Fetch, recorder(injectedFirst)),
          // Injects nothing: these must reach the ambient default, never the first call's recorder.
          Effect.andThen(
            loadPartiesClientWithAuthorization(
              { query: 'Example' },
              'Bearer second',
              'correlation-second',
              {},
            ).pipe(Effect.result),
          ),
          Effect.andThen(
            executeDuplicateCandidateDetailWithAuthorization(
              { caseRef: caseRef('1') },
              'Bearer third',
              'correlation-third',
              {},
            ).pipe(Effect.result),
          ),
          // Three concurrent calls on those same shared clients, each with its own base URL and
          // credential: per-call transport must not leak between interleaved fibers.
          Effect.andThen(
            Effect.all(
              [
                loadCounterpartiesClientWithAuthorization(
                  { query: 'Example' },
                  'Bearer a',
                  'correlation-a',
                  {},
                ).pipe(Effect.result),
                loadCounterpartiesClientWithAuthorization(
                  { query: 'Example' },
                  'Bearer b',
                  'correlation-b',
                  { baseUrl: 'https://party.example/party-registry-api' },
                ).pipe(Effect.result),
                executeDuplicateCandidateDetailWithAuthorization(
                  { caseRef: caseRef('4') },
                  'Bearer c',
                  'correlation-c',
                  { baseUrl: 'https://other.example/party-registry-api' },
                ).pipe(Effect.result),
              ],
              { concurrency: 'unbounded' },
            ).pipe(Effect.provideService(FetchHttpClient.Fetch, recorder(injectedLater))),
          ),
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Reuse: six requests, three clients. Each is built before any call runs and never rebuilt, so no
  // call can be the one whose context a later call inherits.
  assert.deepEqual(reflectionsBeforeAnyCall, [1, 1, 1]);
  assert.deepEqual(
    [counterpartiesReflections(), partiesReflections(), duplicateReflections()],
    [1, 1, 1],
  );

  // No inheritance: the injecting call took its own transport and only its own request.
  assert.deepEqual(injectedFirst, [
    {
      authorization: 'Bearer first',
      correlationId: 'correlation-first',
      url: counterpartiesUrl('https://shell.example'),
    },
  ]);

  // Absent injection uses the ordinary default, not whatever the first caller happened to provide.
  assert.deepEqual(ambient.toSorted(byCorrelationId), [
    {
      authorization: 'Bearer second',
      correlationId: 'correlation-second',
      url: partiesUrl('https://shell.example'),
    },
    {
      authorization: 'Bearer third',
      correlationId: 'correlation-third',
      url: duplicateUrl('https://shell.example'),
    },
  ]);

  // Per-call injection wins on those same shared clients, and three concurrent calls each keep their
  // own base URL and their own credential.
  assert.deepEqual(injectedLater.toSorted(byCorrelationId), [
    {
      authorization: 'Bearer a',
      correlationId: 'correlation-a',
      url: counterpartiesUrl('https://shell.example'),
    },
    {
      authorization: 'Bearer b',
      correlationId: 'correlation-b',
      url: counterpartiesUrl('https://party.example'),
    },
    {
      authorization: 'Bearer c',
      correlationId: 'correlation-c',
      url: duplicateUrl('https://other.example'),
    },
  ]);
});

/**
 * The deadline covers the whole operation — request and decode — and is a typed failure, not a
 * defect. A stalled body must not hang the caller, and the timeout must not resend the request:
 * these reads are idempotent, but a retry policy is a separate decision from a deadline.
 */
test('fails a stalled read with a typed TimeoutError and never resends it', async () => {
  const originalFetch = globalThis.fetch;
  const attempts: string[] = [];
  // Never settles on its own; a body that stalls after the response headers behaves the same way.
  // Settles only when the deadline aborts the request, which is the behaviour under test.
  const stalled: typeof globalThis.fetch = (input, init) => {
    attempts.push(String(input));
    const pending = Promise.withResolvers<Response>();
    init?.signal?.addEventListener('abort', () => {
      pending.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    return pending.promise;
  };

  globalThis.fetch = stalled;
  await withStubbedLocation(async () => {
    try {
      const { loadPartiesClientWithAuthorization } =
        await import('../../src/api/parties-search-client.ts');
      const failure = await Effect.runPromise(
        loadPartiesClientWithAuthorization(
          { query: 'Example' },
          'Bearer test',
          'correlation-timeout',
          { timeoutMs: 10 },
        ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, stalled)),
      );

      assert.equal((failure as { readonly _tag: string })._tag, 'TimeoutError');
      // One attempt: the deadline interrupts the in-flight request, it does not schedule another.
      assert.deepEqual(attempts, [partiesUrl('https://shell.example')]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
