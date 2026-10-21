// @rstest-environment node
import { expect, test } from 'effect-rstest';

import {
  classifyOAuthPath,
  fullOAuthPath,
  oauthIssuerFor,
  oauthNotFoundResponse,
  oauthPreflightResponse,
  validateAuthorizeRedirectUri,
  withOAuthResponseHeaders,
} from '../../../api/auth/oauth-server/policy.ts';

const BASE = '/shell-super-app-api/oauth';

test('oauthIssuerFor normalizes trailing slashes to the exact issuer', () => {
  expect(oauthIssuerFor('http://localhost:3020')).toBe('http://localhost:3020/shell-super-app-api/oauth');
  expect(oauthIssuerFor('http://localhost:3020/')).toBe('http://localhost:3020/shell-super-app-api/oauth');
});

test('fullOAuthPath restores the BFF prefix only when it is missing', () => {
  expect(fullOAuthPath('/oauth/oauth2/token')).toBe('/shell-super-app-api/oauth/oauth2/token');
  expect(fullOAuthPath('/shell-super-app-api/oauth/jwks')).toBe('/shell-super-app-api/oauth/jwks');
});

test('classifyOAuthPath serves the public OAuth endpoints', () => {
  for (const path of [
    `${BASE}/oauth2/authorize`,
    `${BASE}/oauth2/token`,
    `${BASE}/oauth2/consent`,
    `${BASE}/oauth2/continue`,
    `${BASE}/oauth2/revoke`,
    `${BASE}/oauth2/userinfo`,
    `${BASE}/oauth2/public-client-prelogin`,
    `${BASE}/error`,
  ]) {
    expect(classifyOAuthPath(path)).toBe('endpoint');
  }
});

test('classifyOAuthPath serves the metadata and JWKS documents', () => {
  for (const path of [
    `${BASE}/jwks`,
    `${BASE}/.well-known/oauth-authorization-server`,
    `${BASE}/.well-known/openid-configuration`,
  ]) {
    expect(classifyOAuthPath(path)).toBe('metadata');
  }
});

test('classifyOAuthPath blocks registration, admin, session and foreign routes', () => {
  for (const path of [
    `${BASE}/oauth2/register`,
    `${BASE}/oauth2/create-client`,
    `${BASE}/oauth2/introspect`,
    `${BASE}/admin/oauth2/update-client`,
    `${BASE}/sign-in/email`,
    `${BASE}/get-session`,
    `${BASE}/token`,
    '/shell-super-app-api/auth/sign-in',
    '/shell-super-app-api/oauth',
  ]) {
    expect(classifyOAuthPath(path)).toBe('blocked');
  }
});

test('withOAuthResponseHeaders sets no-store on endpoints and drops credentialed CORS', () => {
  const response = withOAuthResponseHeaders(
    'endpoint',
    new Response('x', { headers: { 'access-control-allow-credentials': 'true' }, status: 302 }),
  );
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.has('access-control-allow-credentials')).toBe(false);
  expect(response.status).toBe(302);
});

test('withOAuthResponseHeaders adds anonymous CORS and a 5 minute cache on metadata', () => {
  const response = withOAuthResponseHeaders('metadata', new Response('{}'));
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('cache-control')).toBe('public, max-age=300');
});

test('withOAuthResponseHeaders keeps an existing metadata cache-control value', () => {
  const response = withOAuthResponseHeaders('metadata', new Response('{}', { headers: { 'cache-control': 'max-age=60' } }));
  expect(response.headers.get('cache-control')).toBe('max-age=60');
});

test('oauthPreflightResponse answers 204 with anonymous CORS', () => {
  const response = oauthPreflightResponse();
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
});

test('oauthNotFoundResponse answers 404', () => {
  expect(oauthNotFoundResponse().status).toBe(404);
});

test('validateAuthorizeRedirectUri accepts an ephemeral loopback port for a registered loopback path', () => {
  expect(validateAuthorizeRedirectUri('http://localhost:54321/callback', ['http://localhost/callback'], false)).toBe(true);
});

test('validateAuthorizeRedirectUri accepts the built-in exact match', () => {
  expect(validateAuthorizeRedirectUri('http://127.0.0.1:33418/', ['http://127.0.0.1:33418/'], true)).toBe(true);
});

test('validateAuthorizeRedirectUri accepts an IPv6 loopback on any port', () => {
  expect(validateAuthorizeRedirectUri('http://[::1]:7777/cb', ['http://[::1]/cb'], false)).toBe(true);
});

test('validateAuthorizeRedirectUri rejects a different loopback path', () => {
  expect(validateAuthorizeRedirectUri('http://localhost:5000/other', ['http://localhost/callback'], false)).toBe(false);
});

test('validateAuthorizeRedirectUri rejects a different loopback host', () => {
  expect(validateAuthorizeRedirectUri('http://127.0.0.1:5000/callback', ['http://localhost/callback'], false)).toBe(false);
});

test('validateAuthorizeRedirectUri rejects a non-loopback redirect', () => {
  expect(validateAuthorizeRedirectUri('https://evil.example/cb', ['http://localhost/callback'], false)).toBe(false);
});

test('validateAuthorizeRedirectUri rejects a loopback redirect carrying a fragment', () => {
  expect(validateAuthorizeRedirectUri('http://localhost:1/callback#x', ['http://localhost/callback'], false)).toBe(false);
});

test('validateAuthorizeRedirectUri accepts an exact registered https redirect', () => {
  expect(
    validateAuthorizeRedirectUri(
      'https://chatgpt.com/connector_platform_oauth_redirect',
      ['https://chatgpt.com/connector_platform_oauth_redirect'],
      true,
    ),
  ).toBe(true);
});
