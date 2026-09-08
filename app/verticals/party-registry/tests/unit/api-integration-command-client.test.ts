import { makeCommandAssertionFetch } from '../support/command-assertion-fetch.ts';
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import {
  requestSearchRebuild,
  requestSearchRebuildWithAuthorization,
} from '../../src/api/party-command-client.ts';

test('fresh assertions and command metadata reach the independent owner deployment', async () => {
  const { requests, assertions, fakeFetch } = makeCommandAssertionFetch(
    () => Response.json({ requestId: '10000000-0000-4000-8000-000000000001', status: 'QUEUED' }),
    'token',
  );
  const options = {
    baseUrl: 'https://party.example/party-registry-api',
    correlationId: 'command-correlation',
    gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
    idempotencyKey: 'rebuild-1',
    traceId: 'command-trace',
  };
  const invoke = () =>
    runEffectTestPromise(
      requestSearchRebuild({}, options).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      ),
    );
  const first = await invoke();
  const second = await invoke();
  assert.equal(first.status, 'QUEUED');
  assert.equal(second.status, 'QUEUED');
  assert.equal(assertions(), 2);
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
    await runEffectTestPromise(
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
