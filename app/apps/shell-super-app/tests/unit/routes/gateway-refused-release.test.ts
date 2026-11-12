import { Effect } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';
import {
  documentGatewayAssertion,
  warmDocumentGatewayAssertions,
} from '../../../src/routes/document-gateway-assertions.ts';

const platformFetch = rstest.fn<typeof globalThis.fetch>();
const originalFetch = globalThis.fetch;
const gatewayUrl = '/shell-super-app-api/auth/gateway-context';
const staleRevision = 'a'.repeat(64);
const reloadRequired = {
  detail: 'The document release is no longer admitted. Reload to continue.',
  reloadRequired: true,
  status: 409,
  title: 'Reload required',
  type: 'https://ontos.dev/problems/gateway-reload-required',
};
const ask = (audience: string) =>
  Effect.promise(() =>
    globalThis.fetch(gatewayUrl, {
      body: JSON.stringify({ audience, compositionRevision: staleRevision }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  );

beforeAll(() => {
  globalThis.fetch = platformFetch;
  installBrowserRequestCache();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  platformFetch.mockReset();
  platformFetch.mockImplementation(() =>
    Promise.resolve(
      Response.json(reloadRequired, { headers: { 'content-type': 'application/problem+json' }, status: 409 }),
    ),
  );
});

it.live('a tab told "reload required" asks the Shell for no further gateway context until it reloads', () =>
  Effect.gen(function* refusedRelease() {
    yield* clearBrowserRequestCache;
    const first = yield* ask('party-registry');
    expect(first.status).toBe(409);
    expect(platformFetch).toHaveBeenCalledTimes(1);
    // Every further request of that release, for any audience, is answered with the same refusal and sent nowhere.
    for (const audience of ['party-registry', 'crm', 'catalog']) {
      const again = yield* ask(audience);
      expect(again.status).toBe(409);
      expect(yield* Effect.promise(() => again.json())).toEqual(reloadRequired);
    }
    // Neither does the document's batch renewal nor its assertion lookup ask again.
    yield* warmDocumentGatewayAssertions(staleRevision, ['party-registry', 'crm']);
    expect((yield* documentGatewayAssertion('crm', staleRevision))._tag).toBe('None');
    expect(platformFetch).toHaveBeenCalledTimes(1);
  }),
);
