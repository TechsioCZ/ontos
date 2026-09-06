// @effect-diagnostics asyncFunction:off -- node:test owns these async fixture callbacks; remove-when: the shared itEffect harness covers vertical client transport tests
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { makeActionGateway } from '../../src/api/action-gateway.ts';
import { executePartyDetailWithAuthorization } from '../../src/api/party-detail-client.ts';
import { requestSearchRebuild } from '../../src/api/party-command-client.ts';

const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party' as const,
  tenantId: '20000000-0000-4000-8000-000000000001',
};

test('the action gateway hands every attempt an assertion that cannot be printed', async () => {
  const gateway = makeActionGateway(() =>
    Effect.succeed({ expiresAt: 1_788_430_000, token: 'signed-gateway-token' }),
  );
  const acquired = await Effect.runPromise(gateway.invoke(Effect.succeed));
  assert.equal(Redacted.isRedacted(acquired), true);
  assert.equal(Redacted.value(acquired), 'Bearer signed-gateway-token');
  assert.equal(String(acquired), '<redacted>');
  assert.equal(`${acquired}`.includes('signed-gateway-token'), false);
  assert.equal(JSON.stringify({ authorization: acquired }), '{"authorization":"<redacted>"}');
  assert.equal(
    JSON.stringify({ cause: `assertion rejected: ${acquired}` }).includes('signed-gateway-token'),
    false,
  );
});

test('a read client unwraps the assertion only into the outgoing HTTP header', async () => {
  const requests: Request[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response(null, { status: 503 }));
  };
  await Effect.runPromise(
    executePartyDetailWithAuthorization(
      { partyRef },
      Redacted.make('Bearer read-assertion'),
      'redaction-correlation',
      { baseUrl: 'https://party.example/party-registry-api' },
    ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
  );
  const [request] = requests;
  assert.ok(request);
  assert.equal(request.headers.get('authorization'), 'Bearer read-assertion');
  assert.equal(request.headers.get('x-correlation-id'), 'redaction-correlation');
});

test('command requests keep the encoded wire header while each assertion stays fresh', async () => {
  const commands: Request[] = [];
  let issued = 0;
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'shell.example') {
      issued += 1;
      return Promise.resolve(Response.json({ expiresAt: 2_000_000_000, token: `token-${issued}` }));
    }
    commands.push(request);
    return Promise.resolve(
      Response.json({ requestId: '10000000-0000-4000-8000-000000000001', status: 'QUEUED' }),
    );
  };
  const options = {
    baseUrl: 'https://party.example/party-registry-api',
    correlationId: 'redaction-correlation',
    gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
    idempotencyKey: 'rebuild-redaction',
    traceId: 'redaction-trace',
  };
  const invoke = () =>
    Effect.runPromise(
      requestSearchRebuild({}, options).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      ),
    );
  await invoke();
  await invoke();
  assert.deepEqual(
    commands.map((request) => request.headers.get('authorization')),
    ['Bearer token-1', 'Bearer token-2'],
  );
  for (const request of commands) {
    assert.equal(request.headers.get('x-correlation-id'), 'redaction-correlation');
    assert.equal(request.headers.get('x-trace-id'), 'redaction-trace');
    assert.equal(request.headers.get('idempotency-key'), 'rebuild-redaction');
  }
});
