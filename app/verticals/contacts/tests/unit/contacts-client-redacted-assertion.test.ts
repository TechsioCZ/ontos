// @effect-diagnostics asyncFunction:off -- node:test owns these async fixture callbacks; remove-when: the shared itEffect harness covers vertical client transport tests
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { makeActionGateway } from '../../src/api/action-gateway.ts';
import { attachPersonEngagement } from '../../src/api/contacts-client.ts';

const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party' as const,
  tenantId: '20000000-0000-4000-8000-000000000001',
};

test('the Contacts action gateway hands every attempt an assertion that cannot be printed', async () => {
  const gateway = makeActionGateway(() =>
    Effect.succeed({ expiresAt: 1_788_430_000, token: 'contacts-gateway-token' }),
  );
  const acquired = await Effect.runPromise(gateway.invoke(Effect.succeed));
  assert.equal(Redacted.isRedacted(acquired), true);
  assert.equal(Redacted.value(acquired), 'Bearer contacts-gateway-token');
  assert.equal(String(acquired), '<redacted>');
  assert.equal(JSON.stringify({ authorization: acquired }), '{"authorization":"<redacted>"}');
  assert.equal(
    JSON.stringify({ detail: `rejected ${acquired}` }).includes('contacts-gateway-token'),
    false,
  );
});

test('a governed Contacts mutation unwraps the assertion only into the outgoing header', async () => {
  const mutations: Request[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'shell.example') {
      return Promise.resolve(
        Response.json({ expiresAt: 2_000_000_000, token: 'contacts-token-1' }),
      );
    }
    mutations.push(request);
    return Promise.resolve(new Response(null, { status: 503 }));
  };
  await Effect.runPromise(
    attachPersonEngagement(
      { partyRef },
      {
        baseUrl: 'https://contacts.example/contacts-api',
        correlationId: 'redaction-correlation',
        gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
        idempotencyKey: 'attach-redaction',
        traceId: 'redaction-trace',
      },
    ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
  );
  const [request] = mutations;
  assert.ok(request);
  assert.equal(request.headers.get('authorization'), 'Bearer contacts-token-1');
  assert.equal(request.headers.get('x-correlation-id'), 'redaction-correlation');
  assert.equal(request.headers.get('x-trace-id'), 'redaction-trace');
  assert.equal(request.headers.get('idempotency-key'), 'attach-redaction');
});
