// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://shell.example/en"}
import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';

import { loadCounterpartiesClient } from '../../src/api/counterparties-search-client.ts';

it.effect('each client attempt obtains a fresh assertion and uses its approved issuer release', () =>
  Effect.gen(function* approvedReleaseClientTransport() {
    // The browser document the generated client runs in, at the Shell origin it was served from.
    expect(globalThis.location.origin).toBe('https://shell.example');
    const compositionRevision = 'a'.repeat(64);
    const apiBaseUrl = '/module-api/party-registry/build-approved/party-registry-api';
    yield* pinDocumentCompositionRevision(compositionRevision);

    const issuerRequests: Request[] = [];
    const ownerRequests: Request[] = [];
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === 'https://shell.example' && url.pathname === '/shell-super-app-api/auth/gateway-context') {
        issuerRequests.push(request);
        return Promise.resolve(
          Response.json({
            apiBaseUrl,
            compositionRevision,
            expiresAt: 2_000_000_000,
            token: `approved-${issuerRequests.length}`,
          }),
        );
      }
      ownerRequests.push(request);
      return Promise.resolve(Response.json([]));
    };
    const invocation = loadCounterpartiesClient({ query: 'Example' }, 'approved-release-request', {
      baseUrl: 'https://caller.example/stale-party-registry-api',
      compositionRevision: 'b'.repeat(64),
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

    expect(yield* invocation).toEqual([]);
    expect(yield* invocation).toEqual([]);
    expect(issuerRequests).toHaveLength(2);
    for (const request of issuerRequests) {
      expect(yield* Effect.promise(() => request.json())).toEqual({
        audience: 'party-registry',
        compositionRevision,
      });
    }
    expect(ownerRequests.map((request) => request.url)).toEqual([
      `https://shell.example${apiBaseUrl}/party.registry/search/counterparties`,
      `https://shell.example${apiBaseUrl}/party.registry/search/counterparties`,
    ]);
    expect(ownerRequests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer approved-1',
      'Bearer approved-2',
    ]);
    for (const request of ownerRequests) {
      expect(request.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(request.headers.get('x-correlation-id')).toBe('approved-release-request');
    }
  }),
);
