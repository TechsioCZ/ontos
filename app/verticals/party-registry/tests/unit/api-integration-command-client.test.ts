// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Result } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import {
  requestSearchRebuild,
  requestSearchRebuildWithAuthorization,
} from '../../src/api/party-command-client.ts';

test('fresh assertions and command metadata reach the independent owner deployment', async () => {
  const requests: Request[] = [];
  let assertions = 0;
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).hostname === 'shell.example') {
      assertions += 1;
      return Promise.resolve(
        Response.json({ expiresAt: 2_000_000_000, token: `token-${assertions}` }),
      );
    }
    return Promise.resolve(
      Response.json({ requestId: '10000000-0000-4000-8000-000000000001', status: 'QUEUED' }),
    );
  };
  const options = {
    baseUrl: 'https://party.example/party-registry-api',
    correlationId: 'command-correlation',
    gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
    idempotencyKey: 'rebuild-1',
    traceId: 'command-trace',
  };
  const invoke = () =>
    Effect.runPromise(
      requestSearchRebuild({}, options).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      ),
    );
  const first = await invoke();
  const second = await invoke();
  assert.equal(first.status, 'QUEUED');
  assert.equal(second.status, 'QUEUED');
  assert.equal(assertions, 2);
  const commands = requests.filter((request) => new URL(request.url).hostname === 'party.example');
  assert.deepEqual(
    commands.map((request) => request.url),
    Array.from(
      { length: 2 },
      () =>
        'https://party.example/party-registry-api/party-registry/actions/request-search-rebuild',
    ),
  );
  assert.deepEqual(
    commands.map((request) => request.headers.get('authorization')),
    ['Bearer token-1', 'Bearer token-2'],
  );
  for (const request of commands) {
    assert.equal(request.headers.get('x-correlation-id'), 'command-correlation');
    assert.equal(request.headers.get('x-trace-id'), 'command-trace');
    assert.equal(request.headers.get('idempotency-key'), 'rebuild-1');
  }
});

test('decodes declared errors without weakening their tag or stable conflict code', async () => {
  const problem = {
    _tag: 'PartyCommandConflictProblem',
    code: 'action_request_hash_conflict',
    detail: 'This key was used with a different command payload.',
    status: 409,
    title: 'Idempotency conflict',
    type: 'urn:ontos:action:request-hash-conflict',
  };
  const fakeFetch: typeof fetch = () =>
    Promise.resolve(
      Response.json(problem, {
        headers: { 'content-type': 'application/problem+json' },
        status: 409,
      }),
    );
  const outcome = await Effect.runPromise(
    requestSearchRebuildWithAuthorization({}, 'Bearer test', {
      baseUrl: 'https://party.example/party-registry-api',
      correlationId: 'conflict',
      idempotencyKey: 'rebuild-1',
    }).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
  );
  assert.ok(Result.isFailure(outcome));
  assert.deepEqual(outcome.failure, problem);
});

test('the browser default uses the relative mounted BFF prefix', async () => {
  const urls: string[] = [];
  const fakeFetch: typeof fetch = (input) => {
    urls.push(String(input));
    return Promise.resolve(
      Response.json({ requestId: '10000000-0000-4000-8000-000000000001', status: 'QUEUED' }),
    );
  };
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example', pathname: '/en' },
  });
  try {
    await Effect.runPromise(
      requestSearchRebuildWithAuthorization({}, 'Bearer test', {
        correlationId: 'relative',
        idempotencyKey: 'rebuild-1',
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)),
    );
    assert.deepEqual(urls, [
      'https://shell.example/party-registry-api/party-registry/actions/request-search-rebuild',
    ]);
  } finally {
    if (location === undefined) {
      Reflect.deleteProperty(globalThis, 'location');
    } else {
      Object.defineProperty(globalThis, 'location', location);
    }
  }
});
