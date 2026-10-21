import { expect, test } from 'effect-rstest';

import { clientNameFrom, readOAuthLoginError, readOAuthLoginRequest } from '../../../../src/routes/[lang]/login/oauth-handoff.ts';

const claudeHref =
  'http://localhost:3020/cs/login?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fclaude-code-client-metadata&redirect_uri=http%3A%2F%2Flocalhost%3A53682%2Fcallback&scope=openid+offline_access+ontos&state=xyz&code_challenge=abc&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A3090%2Fmcp&prompt=login+consent&exp=999&ba_iat=1&ba_param=client_id&sig=SIG';

test('builds a same-origin authorize URL without signature parameters', () => {
  const result = readOAuthLoginRequest(claudeHref);
  expect(result).toBeDefined();
  if (result === undefined) {
    return;
  }
  const authorize = new URL(result.authorizeUrl);
  expect(authorize.origin).toBe('http://localhost:3020');
  expect(authorize.pathname).toBe('/shell-super-app-api/oauth/oauth2/authorize');
  expect(authorize.searchParams.get('sig')).toBeNull();
  expect(authorize.searchParams.get('exp')).toBeNull();
  expect(authorize.searchParams.get('ba_iat')).toBeNull();
  expect(authorize.searchParams.get('ba_param')).toBeNull();
  expect(authorize.searchParams.get('prompt')).toBe('consent');
  expect(authorize.searchParams.get('state')).toBe('xyz');
  expect(authorize.searchParams.get('client_id')).toBe('https://claude.ai/oauth/claude-code-client-metadata');
  expect(authorize.searchParams.get('resource')).toBe('http://localhost:3090/mcp');
  expect(result.clientHost).toBe('claude.ai');
  expect(result.knownClient).toBe(true);
  expect(result.signedQuery).toBe(claudeHref.split('?')[1]);
});

test('drops prompt=login when it is the only prompt value', () => {
  const result = readOAuthLoginRequest(
    'http://localhost:3020/cs/login?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Fx&prompt=login&sig=SIG',
  );
  expect(result).toBeDefined();
  expect(new URL(result?.authorizeUrl ?? '').searchParams.has('prompt')).toBe(false);
});

test('marks an unknown CIMD host as not known and uses it as the banner host', () => {
  const result = readOAuthLoginRequest(
    'http://localhost:3020/cs/login?response_type=code&client_id=https%3A%2F%2Fevil.example%2Fcimd.json&sig=SIG',
  );
  expect(result?.knownClient).toBe(false);
  expect(result?.clientHost).toBe('evil.example');
});

test('keeps the authorize origin on a redirect_uri from another host', () => {
  const result = readOAuthLoginRequest(
    'http://localhost:3020/cs/login?response_type=code&client_id=https%3A%2F%2Fevil.example%2Fcimd.json&redirect_uri=https%3A%2F%2Fattacker.example%2Fcb&sig=SIG',
  );
  expect(result).toBeDefined();
  expect(new URL(result?.authorizeUrl ?? '').origin).toBe('http://localhost:3020');
});

test('returns undefined for ordinary sign-in requests', () => {
  expect(readOAuthLoginRequest('http://localhost:3020/cs/login')).toBeUndefined();
  expect(readOAuthLoginRequest('http://localhost:3020/cs/login?returnTo=%2Fcs%2Fcrm')).toBeUndefined();
  expect(
    readOAuthLoginRequest('http://localhost:3020/cs/login?response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Fx'),
  ).toBeUndefined();
  expect(
    readOAuthLoginRequest('http://localhost:3020/cs/login?response_type=token&client_id=abc&sig=SIG'),
  ).toBeUndefined();
});

test('reads client_name from the prelogin body', () => {
  expect(clientNameFrom({ client_name: ' Claude Code ' })).toBe('Claude Code');
  expect(clientNameFrom({})).toBeUndefined();
  expect(clientNameFrom(null)).toBeUndefined();
  expect(clientNameFrom({ client_name: 5 })).toBeUndefined();
});

test('reads the Czech error card code from oauth_error', () => {
  expect(readOAuthLoginError('http://localhost:3020/cs/login?oauth_error=invalid_redirect')).toBe('invalid_redirect');
  expect(readOAuthLoginError('http://localhost:3020/cs/login?oauth_error=invalid_client')).toBe('invalid_client');
  expect(readOAuthLoginError('http://localhost:3020/cs/login?oauth_error=%3Cscript%3E')).toBe('request_failed');
  expect(readOAuthLoginError('http://localhost:3020/cs/login')).toBeUndefined();
});
