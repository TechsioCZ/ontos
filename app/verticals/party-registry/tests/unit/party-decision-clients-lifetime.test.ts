// @effect-diagnostics asyncFunction:off -- node:test takes an async callback to await the run seams below. remove-when: the shared itEffect/itLayer harness lands (audit B2)
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Result } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { PartyCorrectionApi } from '../../shared/apis/party-correction.ts';
import { PartyMatchDecisionApi } from '../../shared/apis/party-match-decision.ts';
import { PartyMergeReadinessApi } from '../../shared/apis/party-merge-readiness.ts';

interface RecordedRequest {
  readonly authorization: string;
  readonly correlationId: string;
  readonly url: string;
}

/**
 * Construction is counted, not inferred: `HttpApiClient` reads `groups` exactly once per client it
 * builds. Installed before the client modules are imported, hence the `import()` calls below.
 */
const reflections = { correction: 0, matchDecision: 0, mergeReadiness: 0 };
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
countReflections(PartyCorrectionApi, 'correction');
countReflections(PartyMatchDecisionApi, 'matchDecision');
countReflections(PartyMergeReadinessApi, 'mergeReadiness');

const decisionRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-match-decision',
  tenantId: '20000000-0000-4000-8000-000000000001',
} as const;
const correctionRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000002',
  resourceType: 'party.registry.party-correction',
  tenantId: '20000000-0000-4000-8000-000000000001',
} as const;
const mergeReadiness = {
  partyRefs: [
    {
      moduleId: 'party.registry',
      resourceId: '10000000-0000-4000-8000-000000000003',
      resourceType: 'party.registry.party',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    {
      moduleId: 'party.registry',
      resourceId: '10000000-0000-4000-8000-000000000004',
      resourceType: 'party.registry.party',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
  ],
  policyVersion: 'party-merge.v1',
} as const;

const recorder =
  (recorded: RecordedRequest[]): typeof globalThis.fetch =>
  (input, init) => {
    const headers = new Headers(init?.headers);
    recorded.push({
      authorization: headers.get('authorization') ?? '',
      correlationId: headers.get('x-correlation-id') ?? '',
      url: String(input),
    });
    // 503 is a declared typed failure, so each call completes without a decodable body.
    return Promise.resolve(new Response(null, { status: 503 }));
  };

const byCorrelationId = (left: RecordedRequest, right: RecordedRequest) =>
  left.correlationId.localeCompare(right.correlationId);

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

/**
 * One test per claim about shared process state: each of these three modules owns exactly one typed
 * client, and that client keeps nothing from whichever caller happened to run first — a client built
 * inside its first caller would merge that caller's `FetchHttpClient.Fetch` under every later
 * request, so a later call injecting nothing would silently ride the first caller's transport.
 */
test('builds each decision-read client once while retaining nothing from any caller', async () => {
  const originalFetch = globalThis.fetch;
  const injectedFirst: RecordedRequest[] = [];
  const ambient: RecordedRequest[] = [];
  const injectedLater: RecordedRequest[] = [];
  let reflectionsBeforeAnyCall = { correction: 0, matchDecision: 0, mergeReadiness: 0 };

  globalThis.fetch = recorder(ambient);
  await withLocation(async () => {
    try {
      const { executePartyMatchDecisionWithAuthorization } =
        await import('../../src/api/party-match-decision-client.ts');
      const { executePartyCorrectionWithAuthorization } =
        await import('../../src/api/party-correction-client.ts');
      const { executePartyMergeReadinessWithAuthorization } =
        await import('../../src/api/party-merge-readiness-client.ts');
      reflectionsBeforeAnyCall = { ...reflections };

      await Effect.runPromise(
        // Injects a transport of its own. Under the bug, this is the captured caller.
        executePartyMatchDecisionWithAuthorization(
          { decisionRef },
          'Bearer first',
          'first',
          {},
        ).pipe(
          Effect.result,
          Effect.provideService(FetchHttpClient.Fetch, recorder(injectedFirst)),
          // Injects nothing: must reach the ambient default, never the first call's recorder.
          Effect.andThen(
            executePartyCorrectionWithAuthorization(
              { correctionRef },
              'Bearer second',
              'second',
              {},
            ).pipe(Effect.result),
          ),
          Effect.andThen(
            Effect.all(
              [
                executePartyMatchDecisionWithAuthorization(
                  { decisionRef },
                  'Bearer a',
                  'a',
                  {},
                ).pipe(Effect.result),
                executePartyCorrectionWithAuthorization({ correctionRef }, 'Bearer b', 'b', {
                  baseUrl: 'https://party.example/party-registry-api',
                }).pipe(Effect.result),
                executePartyMergeReadinessWithAuthorization(mergeReadiness, 'Bearer c', 'c', {
                  baseUrl: 'https://other.example/party-registry-api',
                }).pipe(Effect.result),
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

  // Reuse: five requests, three clients, each built before any call runs and never rebuilt.
  assert.deepEqual(reflectionsBeforeAnyCall, {
    correction: 1,
    matchDecision: 1,
    mergeReadiness: 1,
  });
  assert.deepEqual(reflections, { correction: 1, matchDecision: 1, mergeReadiness: 1 });

  // No inheritance: the injecting call took its own transport and only its own request.
  assert.deepEqual(injectedFirst, [
    {
      authorization: 'Bearer first',
      correlationId: 'first',
      url: 'https://shell.example/party-registry-api/reads/party-match-decision',
    },
  ]);

  // Absent injection uses the ordinary default, not the first caller's transport.
  assert.deepEqual(ambient, [
    {
      authorization: 'Bearer second',
      correlationId: 'second',
      url: 'https://shell.example/party-registry-api/reads/party-correction',
    },
  ]);

  // Per-call injection wins on those same shared clients: each concurrent call keeps its own base
  // URL and its own credential.
  assert.deepEqual(injectedLater.toSorted(byCorrelationId), [
    {
      authorization: 'Bearer a',
      correlationId: 'a',
      url: 'https://shell.example/party-registry-api/reads/party-match-decision',
    },
    {
      authorization: 'Bearer b',
      correlationId: 'b',
      url: 'https://party.example/party-registry-api/reads/party-correction',
    },
    {
      authorization: 'Bearer c',
      correlationId: 'c',
      url: 'https://other.example/party-registry-api/reads/party-merge-readiness',
    },
  ]);
});

/**
 * A budget is only a deadline if it ends the request too: a timeout that returned while the socket
 * stayed open would leak the connection and blur an abandoned attempt into a rejected one.
 */
test('bounds a stalled read with a typed TimeoutError, aborting it and never retrying', async () => {
  const attempts: string[] = [];
  let aborted = false;
  // Settles only on abort: nothing but the deadline can end this call.
  const stalled: typeof globalThis.fetch = (input, init) => {
    attempts.push(String(input));
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
  };

  const { executePartyMergeReadinessWithAuthorization } =
    await import('../../src/api/party-merge-readiness-client.ts');
  const result = await Effect.runPromise(
    executePartyMergeReadinessWithAuthorization(mergeReadiness, 'Bearer stalled', 'stalled', {
      baseUrl: 'https://slow.example/party-registry-api',
      timeoutMs: 25,
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, stalled)),
  );

  // The deadline is a typed failure, not a defect, and it fired once: expiry interrupts this read
  // rather than re-issuing it.
  assert.equal(Result.isFailure(result) ? result.failure._tag : 'Success', 'TimeoutError');
  assert.equal(aborted, true);
  assert.deepEqual(attempts, [
    'https://slow.example/party-registry-api/reads/party-merge-readiness',
  ]);
  // A per-call budget cannot have rebuilt the process-wide client.
  assert.equal(reflections.mergeReadiness, 1);
});
