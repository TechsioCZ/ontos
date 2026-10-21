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

const guardedEndpoint = (
  seen: Request[],
  guards: Partial<NonNullable<OAuthServerEndpoint['guards']>>,
  handler?: (request: Request) => Promise<Response>,
): OAuthServerEndpoint => ({
  ...fakeEndpoint(seen, handler),
  guards: {
    consentApproved: guards.consentApproved ?? (() => Effect.succeed(true)),
    refreshTokenStatus: guards.refreshTokenStatus ?? (() => Effect.succeed('pass')),
  },
});

const formPost = (path: string, body: string) =>
  new Request(`http://localhost:3020${path}`, {
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });

test('a reused refresh token is refused before Better Auth can drop the other connections', async () => {
  const seen: Request[] = [];
  const calls: Array<{ revokeOnReuse: boolean; token: string }> = [];
  const response = await run(
    guardedEndpoint(seen, {
      refreshTokenStatus: (token, options) => {
        calls.push({ revokeOnReuse: options.revokeOnReuse, token });
        return Effect.succeed('reused');
      },
    }),
    formPost('/oauth/oauth2/token', 'grant_type=refresh_token&refresh_token=old&client_id=c'),
  );
  expect(seen).toHaveLength(0);
  expect(calls).toEqual([{ revokeOnReuse: true, token: 'old' }]);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'invalid_grant', error_description: 'invalid refresh token' });
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('a live refresh token and the code grant reach Better Auth', async () => {
  const seen: Request[] = [];
  await run(guardedEndpoint(seen, {}), formPost('/oauth/oauth2/token', 'grant_type=refresh_token&refresh_token=new'));
  await run(guardedEndpoint(seen, {}), formPost('/oauth/oauth2/token', 'grant_type=authorization_code&code=x'));
  expect(seen).toHaveLength(2);
});

test('revoking an already dead refresh token answers 200 without Better Auth', async () => {
  const seen: Request[] = [];
  const response = await run(
    guardedEndpoint(seen, { refreshTokenStatus: (_token, options) => Effect.succeed(options.revokeOnReuse ? 'pass' : 'dead') }),
    formPost('/oauth/oauth2/revoke', 'token=old&client_id=c'),
  );
  expect(seen).toHaveLength(0);
  expect(response.status).toBe(200);
});

test('consent accept is refused until the draft is approved; deny always passes', async () => {
  const seen: Request[] = [];
  const endpoint = guardedEndpoint(seen, { consentApproved: () => Effect.succeed(false) });
  const consent = (accept: boolean) =>
    new Request('http://localhost:3020/oauth/oauth2/consent', {
      body: JSON.stringify({ accept, oauth_query: 'q' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
  const refused = await run(endpoint, consent(true));
  expect(refused.status).toBe(400);
  expect(seen).toHaveLength(0);
  await run(endpoint, consent(false));
  expect(seen).toHaveLength(1);
});

test('authorize asks Better Auth for offline_access when ontos is requested', async () => {
  const seen: Request[] = [];
  await run(fakeEndpoint(seen), new Request('http://localhost:3020/oauth/oauth2/authorize?client_id=a&scope=ontos'));
  expect(new URL(seen[0]?.url ?? '').searchParams.get('scope')).toBe('ontos offline_access');
});

test('an authorize error without a client redirect goes to the Czech error card', async () => {
  const response = await run(
    fakeEndpoint([], () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Metadata document fetch returned HTTP 404' }), {
          headers: { 'content-type': 'application/json' },
          status: 400,
        }),
      ),
    ),
    new Request('http://localhost:3020/oauth/oauth2/authorize?client_id=https%3A%2F%2Fexample.com%2Fclient.json'),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/cs/login?oauth_error=invalid_client');
});

test('the Better Auth error page redirects to the Czech error card', async () => {
  const seen: Request[] = [];
  const response = await run(fakeEndpoint(seen), new Request('http://localhost:3020/oauth/error?error=invalid_redirect'));
  expect(seen).toHaveLength(0);
  expect(response.headers.get('location')).toBe('/cs/login?oauth_error=invalid_redirect');
  const bare = await run(fakeEndpoint(seen), new Request('http://localhost:3020/oauth/error'));
  expect(bare.headers.get('location')).toBe('/cs/login?oauth_error=request_failed');
});

test('metadata is served without the introspection endpoint', async () => {
  const response = await run(
    fakeEndpoint([], () =>
      Promise.resolve(
        new Response(JSON.stringify({ introspection_endpoint: 'x', issuer: ISSUER }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
    new Request('http://localhost:3020/oauth/.well-known/oauth-authorization-server'),
  );
  expect(await response.json()).toEqual({ issuer: ISSUER });
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
});
