// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { executeAresLookupWithAuthorization } from '../../src/api/ares-lookup-client.ts';
import { loadPartiesClientWithAuthorization } from '../../src/api/parties-search-client.ts';
import { executePartyDetailWithAuthorization } from '../../src/api/party-detail-client.ts';

test('targets the mounted owner BFF prefix and supports a separate owner deployment', async () => {
  const requests: string[] = [];
  const fakeFetch: typeof globalThis.fetch = (input) => {
    requests.push(String(input));
    return Promise.resolve(new Response(null, { status: 503 }));
  };
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en/contacts' },
  });
  const capture = <Success, Failure>(request: Effect.Effect<Success, Failure>) =>
    Effect.runPromise(
      request.pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
    );
  try {
    await capture(executeAresLookupWithAuthorization({ ico: '12345678' }, 'Bearer test', 'test'));
    await capture(
      executePartyDetailWithAuthorization(
        {
          partyRef: {
            moduleId: 'party.registry',
            resourceId: '10000000-0000-4000-8000-000000000001',
            resourceType: 'party.registry.party',
            tenantId: '20000000-0000-4000-8000-000000000001',
          },
        },
        'Bearer test',
        'test',
      ),
    );
    await capture(loadPartiesClientWithAuthorization({ query: 'Example' }, 'Bearer test', 'test'));
    await capture(
      executeAresLookupWithAuthorization({ ico: '12345678' }, 'Bearer test', 'test', {
        baseUrl: 'https://party.example/party-registry-api',
      }),
    );
    assert.deepEqual(requests, [
      'https://shell.example/party-registry-api/reads/ares-lookup',
      'https://shell.example/party-registry-api/reads/party-detail',
      'https://shell.example/party-registry-api/party.registry/search/parties',
      'https://party.example/party-registry-api/reads/ares-lookup',
    ]);
  } finally {
    if (location === undefined) {
      Reflect.deleteProperty(globalThis, 'location');
    } else {
      Object.defineProperty(globalThis, 'location', location);
    }
  }
});
