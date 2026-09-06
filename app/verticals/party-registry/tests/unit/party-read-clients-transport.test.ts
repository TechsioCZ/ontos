// @effect-diagnostics asyncFunction:off -- node:test takes an async callback to await the run seams below. remove-when: the shared itEffect/itLayer harness lands (audit B2)
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { executePartyContactPointDetailWithAuthorization } from '../../src/api/party-contact-point-detail-client.ts';
import { executePartyContactPointsWithAuthorization } from '../../src/api/party-contact-points-client.ts';
import { executePartyRelationshipDetailWithAuthorization } from '../../src/api/party-relationship-detail-client.ts';

interface RecordedRequest {
  readonly authorization: string;
  readonly correlationId: string;
  readonly url: string;
}

const tenantId = '20000000-0000-4000-8000-000000000001';

const partyRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId,
} as const;

const contactPointRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000002',
  resourceType: 'party.registry.party-contact-point',
  tenantId,
} as const;

const relationshipRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000003',
  resourceType: 'party.registry.party-relationship',
  tenantId,
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
    // 503 is a declared typed failure, so each call completes without needing a decodable body.
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
 * Each module's client is shared for the life of the process, so the per-call credential and base URL
 * must travel with the request rather than with the client. Interleaving the three reads concurrently
 * on one injected transport is what would expose a client that retained either.
 */
test('the three shared read clients keep each concurrent call on its own base URL and credential', async () => {
  const recorded: RecordedRequest[] = [];
  await withLocation(async () => {
    await Effect.runPromise(
      Effect.all(
        [
          executePartyContactPointsWithAuthorization(
            { partyRef },
            Redacted.make('Bearer points'),
            'correlation-a',
          ).pipe(Effect.result),
          executePartyContactPointDetailWithAuthorization(
            { contactPointRef },
            Redacted.make('Bearer point-detail'),
            'correlation-b',
            { baseUrl: 'https://party.example/party-registry-api' },
          ).pipe(Effect.result),
          executePartyRelationshipDetailWithAuthorization(
            { relationshipRef },
            Redacted.make('Bearer relationship'),
            'correlation-c',
            { baseUrl: new URL('https://other.example/party-registry-api') },
          ).pipe(Effect.result),
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, recorder(recorded))),
    );
  });

  assert.deepEqual(recorded.toSorted(byCorrelationId), [
    {
      authorization: 'Bearer points',
      correlationId: 'correlation-a',
      url: 'https://shell.example/party-registry-api/reads/party-contact-points',
    },
    {
      authorization: 'Bearer point-detail',
      correlationId: 'correlation-b',
      url: 'https://party.example/party-registry-api/reads/party-contact-point-detail',
    },
    {
      authorization: 'Bearer relationship',
      correlationId: 'correlation-c',
      url: 'https://other.example/party-registry-api/reads/party-relationship-detail',
    },
  ]);
});

/**
 * The budget covers the whole operation, decode included, and expires as a typed `TimeoutError`. A
 * read is idempotent but its side effects are the server's, so the timeout must not resend: one
 * request is issued and the caller is told the outcome is unknown, not that it failed.
 */
test('an exhausted budget fails with a typed TimeoutError and never reissues the request', async () => {
  let attempts = 0;
  const stalledFetch: typeof globalThis.fetch = () => {
    attempts += 1;
    // An empty race never settles: the deadline, not the transport, is what must end the call.
    return Promise.race<Response>([]);
  };

  await withLocation(async () => {
    const outcome = await Effect.runPromise(
      executePartyContactPointsWithAuthorization(
        { partyRef },
        Redacted.make('Bearer stalled'),
        'correlation-d',
        {
          timeoutMs: 20,
        },
      ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, stalledFetch)),
    );

    assert.equal(outcome._tag, 'Failure');
    assert.equal(outcome.failure._tag, 'TimeoutError');
  });

  assert.equal(attempts, 1);
});
