// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://shell.example/en"}
import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import { requestSearchRebuild, requestSearchRebuildWithAuthorization } from '../../src/api/party-command-client.ts';

it.effect('fresh assertions and command metadata reach the admitted owner release', () =>
  Effect.gen(function* testProgram1() {
    const compositionRevision = 'a'.repeat(64);
    const apiBaseUrl = '/module-api/party-registry/build-approved/party-registry-api';
    yield* pinDocumentCompositionRevision(compositionRevision);
    const requests: Request[] = [];
    let assertions = 0;
    const fakeFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      expect(url.origin).toBe('https://shell.example');
      if (url.pathname === '/shell-super-app-api/auth/gateway-context') {
        assertions += 1;
        return Promise.resolve(
          Response.json({
            apiBaseUrl,
            compositionRevision,
            expiresAt: 2_000_000_000,
            token: `token-${assertions}`,
          }),
        );
      }
      expect(url.pathname).toBe(`${apiBaseUrl}/party-registry/actions/request-search-rebuild`);
      return Promise.resolve(
        Response.json({
          requestId: '10000000-0000-4000-8000-000000000001',
          status: 'QUEUED',
        }),
      );
    };
    const options = {
      baseUrl: 'https://party.example/party-registry-api',
      compositionRevision: 'b'.repeat(64),
      correlationId: 'command-correlation',
      gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
      idempotencyKey: 'rebuild-1',
      traceId: 'command-trace',
    };
    const invoke = () =>
      requestSearchRebuild({}, options).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    const first = yield* invoke();
    const second = yield* invoke();
    expect(first.status).toBe('QUEUED');
    expect(second.status).toBe('QUEUED');
    expect(assertions).toBe(2);
    const gatewayRequests = requests.filter(
      (request) => new URL(request.url).pathname === '/shell-super-app-api/auth/gateway-context',
    );
    for (const request of gatewayRequests) {
      expect(yield* Effect.promise(() => request.json())).toEqual({ audience: 'party-registry', compositionRevision });
    }
    const commands = requests.filter((request) => new URL(request.url).pathname.startsWith(`${apiBaseUrl}/`));
    expect(commands.map((request) => request.url)).toEqual(
      Array.from(
        { length: 2 },
        () => `https://shell.example${apiBaseUrl}/party-registry/actions/request-search-rebuild`,
      ),
    );
    expect(commands.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
    for (const request of commands) {
      expect(request.headers.get('x-correlation-id')).toBe('command-correlation');
      expect(request.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(request.headers.get('x-trace-id')).toBe('command-trace');
      expect(request.headers.get('idempotency-key')).toBe('rebuild-1');
    }
  }),
);

it.effect('the browser default uses the relative mounted BFF prefix', () =>
  Effect.gen(function* testProgram3() {
    const urls: string[] = [];
    const fakeFetch: typeof fetch = (input) => {
      urls.push(String(input));
      return Promise.resolve(
        Response.json({
          requestId: '10000000-0000-4000-8000-000000000001',
          status: 'QUEUED',
        }),
      );
    };
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (location === undefined) {
          Reflect.deleteProperty(globalThis, 'location');
        } else {
          Object.defineProperty(globalThis, 'location', location);
        }
      }),
    );
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://shell.example', pathname: '/en' },
    });
    yield* requestSearchRebuildWithAuthorization({}, 'Bearer test', {
      correlationId: 'relative',
      idempotencyKey: 'rebuild-1',
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(urls).toEqual(['https://shell.example/party-registry-api/party-registry/actions/request-search-rebuild']);
  }),
);
