// @rstest-environment node
import { expect, test } from 'effect-rstest';
import { Effect } from 'effect';

import { forwardOAuthRequest, toBetterAuthRequest } from '../../../api/auth/oauth-server/forward.ts';
import type { OAuthServerEndpoint } from '../../../api/auth/oauth-server/policy.ts';

const ISSUER = 'http://localhost:3020/shell-super-app-api/oauth';

const fakeEndpoint = (seen: Request[], handler?: (request: Request) => Promise<Response>): OAuthServerEndpoint => ({
  handler: (request) => {
    seen.push(request);
    return handler ? handler(request) : Promise.resolve(new Response('ok', { status: 200 }));
  },
  issuer: ISSUER,
});

const run = (endpoint: OAuthServerEndpoint, request: Request): Promise<Response> =>
  Effect.runPromise(forwardOAuthRequest(endpoint)(request));

test('POST token forwards the full issuer-prefixed URL and body', async () => {
  const seen: Request[] = [];
  const response = await run(
    fakeEndpoint(seen),
    new Request('http://127.0.0.1:3020/oauth/oauth2/token', {
      body: 'grant_type=refresh_token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    }),
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe('http://localhost:3020/shell-super-app-api/oauth/oauth2/token');
  expect(await seen[0]?.text()).toBe('grant_type=refresh_token');
  expect(seen[0]?.method).toBe('POST');
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('GET authorize keeps the query string', async () => {
  const seen: Request[] = [];
  await run(
    fakeEndpoint(seen),
    new Request('http://localhost:3020/shell-super-app-api/oauth/oauth2/authorize?client_id=a&state=s'),
  );
  expect(seen[0]?.url).toBe('http://localhost:3020/shell-super-app-api/oauth/oauth2/authorize?client_id=a&state=s');
});

test('GET openid-configuration is served with anonymous CORS', async () => {
  const seen: Request[] = [];
  const response = await run(
    fakeEndpoint(seen),
    new Request('http://localhost:3020/oauth/.well-known/openid-configuration'),
  );
  expect(seen).toHaveLength(1);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
});

test('OPTIONS jwks answers the preflight without calling the handler', async () => {
  const seen: Request[] = [];
  const response = await run(fakeEndpoint(seen), new Request('http://localhost:3020/oauth/jwks', { method: 'OPTIONS' }));
  expect(response.status).toBe(204);
  expect(seen).toHaveLength(0);
});

test('dynamic client registration is blocked without calling the handler', async () => {
  const seen: Request[] = [];
  const response = await run(
    fakeEndpoint(seen),
    new Request('http://localhost:3020/oauth/oauth2/register', { body: '{}', method: 'POST' }),
  );
  expect(response.status).toBe(404);
  expect(seen).toHaveLength(0);
});

test('non-OAuth Better Auth routes are blocked without calling the handler', async () => {
  const seen: Request[] = [];
  const response = await run(fakeEndpoint(seen), new Request('http://localhost:3020/oauth/get-session'));
  expect(response.status).toBe(404);
  expect(seen).toHaveLength(0);
});

test('a handler failure becomes a 500 server_error', async () => {
  const endpoint = fakeEndpoint([], () => Promise.reject(new Error('boom')));
  const response = await run(endpoint, new Request('http://localhost:3020/oauth/oauth2/token', { method: 'GET' }));
  expect(response.status).toBe(500);
});

test('toBetterAuthRequest ignores the request host', () => {
  const request = toBetterAuthRequest(ISSUER, new Request('http://evil.example/oauth/jwks'), undefined);
  expect(request.url).toBe('http://localhost:3020/shell-super-app-api/oauth/jwks');
});
