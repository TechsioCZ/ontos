import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import {
  requestSearchRebuild,
  requestSearchRebuildWithAuthorization,
} from '../../src/api/party-command-client.ts';
import { makeCommandAssertionFetch } from '../support/command-assertion-fetch.ts';

it.effect(
  'fresh assertions and command metadata reach the independent owner deployment',
  () =>
    Effect.gen(function* testProgram1() {
      const { requests, assertions, fakeFetch } = makeCommandAssertionFetch(
        () =>
          Response.json({
            requestId: '10000000-0000-4000-8000-000000000001',
            status: 'QUEUED',
          }),
        'token'
      );
      const options = {
        baseUrl: 'https://party.example/party-registry-api',
        correlationId: 'command-correlation',
        gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
        idempotencyKey: 'rebuild-1',
        traceId: 'command-trace',
      };
      const invoke = () =>
        requestSearchRebuild({}, options).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
        );
      const first = yield* invoke();
      const second = yield* invoke();
      expect(first.status).toBe('QUEUED');
      expect(second.status).toBe('QUEUED');
      expect(assertions()).toBe(2);
      const commands = requests.filter(
        (request) => new URL(request.url).hostname === 'party.example'
      );
      expect(commands.map((request) => request.url)).toEqual(
        Array.from(
          { length: 2 },
          () =>
            'https://party.example/party-registry-api/party-registry/actions/request-search-rebuild'
        )
      );
      expect(
        commands.map((request) => request.headers.get('authorization'))
      ).toEqual(['Bearer token-1', 'Bearer token-2']);
      for (const request of commands) {
        expect(request.headers.get('x-correlation-id')).toBe(
          'command-correlation'
        );
        expect(request.headers.get('x-trace-id')).toBe('command-trace');
        expect(request.headers.get('idempotency-key')).toBe('rebuild-1');
      }
    })
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
        })
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
      })
    );
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://shell.example', pathname: '/en' },
    });
    yield* requestSearchRebuildWithAuthorization({}, 'Bearer test', {
      correlationId: 'relative',
      idempotencyKey: 'rebuild-1',
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(urls).toEqual([
      'https://shell.example/party-registry-api/party-registry/actions/request-search-rebuild',
    ]);
  })
);
