// @rstest-environment node
import { expect, it } from 'effect-rstest';
import { Cause, Effect, Redacted } from 'effect';

import { forwardOAuthRequest, toBetterAuthRequest } from '../../../api/auth/oauth-server/forward.ts';
import type { OAuthServerEndpoint } from '../../../api/auth/oauth-server/policy.ts';

const ISSUER = 'http://localhost:3020/shell-super-app-api/oauth';

const fakeEndpoint = (seen: Request[], handler?: OAuthServerEndpoint['handler']): OAuthServerEndpoint => ({
  handler: (request) =>
    Effect.suspend(() => {
      seen.push(request);
      return handler ? handler(request) : Effect.succeed(new Response('ok', { status: 200 }));
    }),
  issuer: ISSUER,
});

const guardedEndpoint = (
  seen: Request[],
  guards: Partial<NonNullable<OAuthServerEndpoint['guards']>>,
  handler?: OAuthServerEndpoint['handler'],
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

const consentPost = (accept: boolean) =>
  new Request('http://localhost:3020/oauth/oauth2/consent', {
    body: accept ? '{"accept":true,"oauth_query":"q"}' : '{"accept":false,"oauth_query":"q"}',
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

it.effect('POST token forwards the full issuer-prefixed URL and body', () =>
  Effect.gen(function* forwardsTokenRequest() {
    const seen: Request[] = [];
    const response = yield* forwardOAuthRequest(fakeEndpoint(seen))(
      new Request('http://127.0.0.1:3020/oauth/oauth2/token', {
        body: 'grant_type=refresh_token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://localhost:3020/shell-super-app-api/oauth/oauth2/token');
    expect(yield* Effect.promise(async () => await seen[0]?.text())).toBe('grant_type=refresh_token');
    expect(seen[0]?.method).toBe('POST');
    expect(response.headers.get('cache-control')).toBe('no-store');
  }),
);

it.effect('GET authorize keeps the query string', () =>
  Effect.gen(function* keepsAuthorizeQuery() {
    const seen: Request[] = [];
    yield* forwardOAuthRequest(fakeEndpoint(seen))(
      new Request('http://localhost:3020/shell-super-app-api/oauth/oauth2/authorize?client_id=a&state=s'),
    );
    expect(seen[0]?.url).toBe('http://localhost:3020/shell-super-app-api/oauth/oauth2/authorize?client_id=a&state=s');
  }),
);

it.effect('GET openid-configuration is served with anonymous CORS', () =>
  Effect.gen(function* servesMetadata() {
    const seen: Request[] = [];
    const response = yield* forwardOAuthRequest(fakeEndpoint(seen))(
      new Request('http://localhost:3020/oauth/.well-known/openid-configuration'),
    );
    expect(seen).toHaveLength(1);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  }),
);

it.effect('OPTIONS jwks answers the preflight without calling the handler', () =>
  Effect.gen(function* servesPreflight() {
    const seen: Request[] = [];
    const response = yield* forwardOAuthRequest(fakeEndpoint(seen))(
      new Request('http://localhost:3020/oauth/jwks', { method: 'OPTIONS' }),
    );
    expect(response.status).toBe(204);
    expect(seen).toHaveLength(0);
  }),
);

it.effect('dynamic client registration is blocked without calling the handler', () =>
  Effect.gen(function* blocksRegistration() {
    const seen: Request[] = [];
    const response = yield* forwardOAuthRequest(fakeEndpoint(seen))(
      new Request('http://localhost:3020/oauth/oauth2/register', { body: '{}', method: 'POST' }),
    );
    expect(response.status).toBe(404);
    expect(seen).toHaveLength(0);
  }),
);

it.effect('non-OAuth Better Auth routes are blocked without calling the handler', () =>
  Effect.gen(function* blocksOtherRoutes() {
    const seen: Request[] = [];
    const response = yield* forwardOAuthRequest(fakeEndpoint(seen))(
      new Request('http://localhost:3020/oauth/get-session'),
    );
    expect(response.status).toBe(404);
    expect(seen).toHaveLength(0);
  }),
);

it.effect('a handler failure becomes a 500 server_error', () =>
  Effect.gen(function* rejectsHandlerFailure() {
    const endpoint = fakeEndpoint([], () => Effect.fail(new Cause.UnknownError(new Error('boom'))));
    const response = yield* forwardOAuthRequest(endpoint)(
      new Request('http://localhost:3020/oauth/oauth2/token', { method: 'GET' }),
    );
    expect(response.status).toBe(500);
    expect(yield* Effect.promise(async () => await response.json())).toEqual({ error: 'server_error' });
  }),
);

it('toBetterAuthRequest ignores the request host', () => {
  const request = toBetterAuthRequest(ISSUER, new Request('http://evil.example/oauth/jwks'));
  expect(request.url).toBe('http://localhost:3020/shell-super-app-api/oauth/jwks');
});

it.effect('a reused refresh token is refused before Better Auth can drop the other connections', () =>
  Effect.gen(function* refusesReusedToken() {
    const seen: Request[] = [];
    const calls: { revokeOnReuse: boolean; token: string }[] = [];
    const endpoint = guardedEndpoint(seen, {
      refreshTokenStatus: (token, options) =>
        Effect.sync(() => {
          calls.push({ revokeOnReuse: options.revokeOnReuse, token: Redacted.value(token) });
          return 'reused' as const;
        }),
    });
    const response = yield* forwardOAuthRequest(endpoint)(
      formPost('/oauth/oauth2/token', 'grant_type=refresh_token&refresh_token=old&client_id=c'),
    );
    expect(seen).toHaveLength(0);
    expect(calls).toEqual([{ revokeOnReuse: true, token: 'old' }]);
    expect(response.status).toBe(400);
    expect(yield* Effect.promise(async () => await response.json())).toEqual({
      error: 'invalid_grant',
      error_description: 'invalid refresh token',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  }),
);

it.effect('a live refresh token and the code grant reach Better Auth', () =>
  Effect.gen(function* forwardsLiveAndCodeGrants() {
    const seen: Request[] = [];
    const calls: { revokeOnReuse: boolean; token: string }[] = [];
    const endpoint = guardedEndpoint(seen, {
      refreshTokenStatus: (token, options) =>
        Effect.sync(() => {
          expect(Redacted.isRedacted(token)).toBe(true);
          calls.push({ revokeOnReuse: options.revokeOnReuse, token: Redacted.value(token) });
          return 'pass' as const;
        }),
    });
    const refresh = yield* forwardOAuthRequest(endpoint)(
      formPost('/oauth/oauth2/token', 'grant_type=refresh_token&refresh_token=new'),
    );
    const code = yield* forwardOAuthRequest(endpoint)(
      formPost('/oauth/oauth2/token', 'grant_type=authorization_code&code=x'),
    );
    expect(seen).toHaveLength(2);
    expect(calls).toEqual([{ revokeOnReuse: true, token: 'new' }]);
    expect(refresh.status).toBe(200);
    expect(code.status).toBe(200);
    expect(yield* Effect.promise(async () => await seen[0]?.text())).toBe('grant_type=refresh_token&refresh_token=new');
    expect(yield* Effect.promise(async () => await seen[1]?.text())).toBe('grant_type=authorization_code&code=x');
  }),
);

it.effect('revoking an already dead refresh token answers 200 without Better Auth', () =>
  Effect.gen(function* revokesDeadToken() {
    const seen: Request[] = [];
    const endpoint = guardedEndpoint(seen, {
      refreshTokenStatus: (_token, options) => Effect.succeed(options.revokeOnReuse ? 'pass' : 'dead'),
    });
    const response = yield* forwardOAuthRequest(endpoint)(formPost('/oauth/oauth2/revoke', 'token=old&client_id=c'));
    expect(seen).toHaveLength(0);
    expect(response.status).toBe(200);
  }),
);

it.effect('consent accept is refused until the draft is approved; deny always passes', () =>
  Effect.gen(function* guardsConsent() {
    const seen: Request[] = [];
    const endpoint = guardedEndpoint(seen, { consentApproved: () => Effect.succeed(false) });
    const refused = yield* forwardOAuthRequest(endpoint)(consentPost(true));
    expect(refused.status).toBe(400);
    expect(seen).toHaveLength(0);
    yield* forwardOAuthRequest(endpoint)(consentPost(false));
    expect(seen).toHaveLength(1);
  }),
);

it.effect('authorize asks Better Auth for offline_access when ontos is requested', () =>
  Effect.gen(function* requestsOfflineAccess() {
    const seen: Request[] = [];
    yield* forwardOAuthRequest(fakeEndpoint(seen))(
      new Request('http://localhost:3020/oauth/oauth2/authorize?client_id=a&scope=ontos'),
    );
    expect(new URL(seen[0]?.url ?? '').searchParams.get('scope')).toBe('ontos offline_access');
  }),
);

it.effect('an authorize error without a client redirect goes to the Czech error card', () =>
  Effect.gen(function* redirectsAuthorizeFailure() {
    const response = yield* forwardOAuthRequest(
      fakeEndpoint([], () =>
        Effect.succeed(
          Response.json(
            { error: 'invalid_client', error_description: 'Metadata document fetch returned HTTP 404' },
            { status: 400 },
          ),
        ),
      ),
    )(new Request('http://localhost:3020/oauth/oauth2/authorize?client_id=https%3A%2F%2Fexample.com%2Fclient.json'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/cs/login?oauth_error=invalid_client');
  }),
);

it.effect('the Better Auth error page redirects to the Czech error card', () =>
  Effect.gen(function* redirectsErrorPage() {
    const seen: Request[] = [];
    const endpoint = fakeEndpoint(seen);
    const response = yield* forwardOAuthRequest(endpoint)(
      new Request('http://localhost:3020/oauth/error?error=invalid_redirect'),
    );
    expect(seen).toHaveLength(0);
    expect(response.headers.get('location')).toBe('/cs/login?oauth_error=invalid_redirect');
    const bare = yield* forwardOAuthRequest(endpoint)(new Request('http://localhost:3020/oauth/error'));
    expect(bare.headers.get('location')).toBe('/cs/login?oauth_error=request_failed');
  }),
);

it.effect('metadata is served without the introspection endpoint', () =>
  Effect.gen(function* removesUnservedMetadata() {
    const response = yield* forwardOAuthRequest(
      fakeEndpoint([], () => Effect.succeed(Response.json({ introspection_endpoint: 'x', issuer: ISSUER }))),
    )(new Request('http://localhost:3020/oauth/.well-known/oauth-authorization-server'));
    expect(yield* Effect.promise(async () => await response.json())).toEqual({ issuer: ISSUER });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  }),
);

it.effect('guarded JSON credentials are decoded and redacted before the guard runs', () =>
  Effect.gen(function* redactsGuardCredentials() {
    const seen: Request[] = [];
    const credentials: string[] = [];
    const endpoint = guardedEndpoint(seen, {
      refreshTokenStatus: (credential) =>
        Effect.sync(() => {
          expect(Redacted.isRedacted(credential)).toBe(true);
          credentials.push(Redacted.value(credential));
          return 'dead' as const;
        }),
    });
    const response = yield* forwardOAuthRequest(endpoint)(
      new Request('http://localhost:3020/oauth/oauth2/token', {
        body: '{"grant_type":"refresh_token","refresh_token":"private-token"}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(credentials).toEqual(['private-token']);
    expect(seen).toHaveLength(0);
    expect(response.status).toBe(400);
  }),
);

it.effect('JSON revocation redacts the credential and checks it without refresh-reuse revocation', () =>
  Effect.gen(function* redactsRevocationCredential() {
    const seen: Request[] = [];
    const calls: { revokeOnReuse: boolean; token: string }[] = [];
    const endpoint = guardedEndpoint(seen, {
      refreshTokenStatus: (token, options) =>
        Effect.sync(() => {
          expect(Redacted.isRedacted(token)).toBe(true);
          expect(JSON.stringify(token)).not.toContain('private-token');
          calls.push({ revokeOnReuse: options.revokeOnReuse, token: Redacted.value(token) });
          return 'dead' as const;
        }),
    });
    const response = yield* forwardOAuthRequest(endpoint)(
      new Request('http://localhost:3020/oauth/oauth2/revoke', {
        body: '{"token":"private-token","client_id":"c"}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(calls).toEqual([{ revokeOnReuse: false, token: 'private-token' }]);
    expect(seen).toHaveLength(0);
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(async () => await response.text())).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
  }),
);

it.effect('malformed guard input is rejected instead of bypassing token and consent checks', () =>
  Effect.gen(function* rejectsMalformedGuardInput() {
    const seen: Request[] = [];
    const endpoint = guardedEndpoint(seen, { consentApproved: () => Effect.succeed(false) });
    for (const [path, body] of [
      ['/oauth2/token', '{"grant_type":"refresh_token","refresh_token":123}'],
      ['/oauth2/consent', '{"accept":[true]}'],
      ['/oauth2/consent', '{not-json'],
    ] as const) {
      const response = yield* forwardOAuthRequest(endpoint)(
        new Request(`http://localhost:3020/oauth${path}`, {
          body,
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      );
      expect(response.status).toBe(400);
      expect(yield* Effect.promise(async () => await response.json())).toEqual({
        error: 'invalid_request',
        error_description: 'invalid request body',
      });
    }
    expect(seen).toHaveLength(0);
  }),
);

it.effect('a request body rejection is an HTTP failure and never reaches Better Auth', () =>
  Effect.gen(function* rejectsUnreadableRequestBody() {
    const seen: Request[] = [];
    const request = formPost('/oauth/oauth2/token', 'grant_type=refresh_token&refresh_token=private-token');
    // A disturbed body has the same native arrayBuffer rejection as an interrupted body stream.
    yield* Effect.promise(async () => await request.text());
    const response = yield* forwardOAuthRequest(guardedEndpoint(seen, {}))(request);
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(yield* Effect.promise(async () => await response.json())).toEqual({ error: 'server_error' });
    expect(seen).toHaveLength(0);
  }),
);

it.effect('response body rejections are failures, not metadata success or an authorize redirect', () =>
  Effect.gen(function* rejectsUnreadableResponseBody() {
    for (const [path, status] of [
      ['/.well-known/oauth-authorization-server', 200],
      ['/oauth2/authorize', 400],
    ] as const) {
      const response = yield* forwardOAuthRequest(
        fakeEndpoint([], () =>
          Effect.succeed(
            new Response(
              new ReadableStream({ start: (controller) => controller.error(new Error('response stream failed')) }),
              { status },
            ),
          ),
        ),
      )(new Request(`http://localhost:3020/oauth${path}`));
      expect(response.status).toBe(500);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  }),
);

it('forwarding retains the real request abort signal', () => {
  const controller = new AbortController();
  const request = new Request('http://evil.example/oauth/jwks', { signal: controller.signal });
  const forwarded = toBetterAuthRequest(ISSUER, request);
  expect(forwarded.signal.aborted).toBe(false);
  controller.abort();
  expect(forwarded.signal.aborted).toBe(true);
});
