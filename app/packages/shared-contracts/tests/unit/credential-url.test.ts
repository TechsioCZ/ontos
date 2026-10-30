import { Effect, Logger } from 'effect';
import { HttpClientRequest, HttpServerRequest, UrlParams } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  authenticationQueryRedactions,
  credentialSubmissionRedirect,
  hasCredentialQuery,
  isSafeSignInReturnPath,
} from '../../src/credential-url.ts';

it('rejects credential aliases, repeated names and encoded names without carrying any query into the redirect', () => {
  for (const query of [
    'login=x&password=y',
    'Password=y',
    '%70assword=y',
    'password=&password=y',
    'newPassword=y',
    'passwordConfirmation=y',
    'api-key=y',
    'client_secret=y',
    'access_token=y',
    'credentials[password]=y',
    'returnTo=%2Fcs%2Fcrm%3Fpassword%3Dy',
  ]) {
    for (const path of ['/cs/login', '/shell-super-app-api/auth/sign-in', '/mcp', '/cs/unknown']) {
      const url = new URL(`https://stage.test${path}?${query}`);
      expect(hasCredentialQuery(url)).toBe(true);
      expect(credentialSubmissionRedirect(url, 'GET')).toBe('/cs/login');
    }
  }
});

it('rejects native credential POSTs without parsing their bodies and preserves typed API calls', () => {
  expect(credentialSubmissionRedirect(new URL('https://stage.test/en/login?returnTo=/en/crm'), 'POST')).toBe(
    '/en/login',
  );
  expect(credentialSubmissionRedirect(new URL('https://stage.test/cs/set-password?token=one-use'), 'POST')).toBe(
    '/cs/login',
  );
  expect(
    credentialSubmissionRedirect(new URL('https://stage.test/shell-super-app-api/auth/sign-in'), 'POST'),
  ).toBeUndefined();
  expect(
    credentialSubmissionRedirect(new URL('https://stage.test/cs/set-password?token=one-use'), 'GET'),
  ).toBeUndefined();
  expect(
    credentialSubmissionRedirect(new URL('https://stage.test/cs/login?client_id=x&sig=signed'), 'GET'),
  ).toBeUndefined();
});

it('keeps localized deep links but rejects external, normalized, encoded and source-code return paths', () => {
  for (const path of [
    '/cs/crm',
    '/cs/prehledy/statistiky?group=month',
    '/cs/modules/crm#recent',
    '/cs/crm?q=two%20words',
  ]) {
    expect(isSafeSignInReturnPath(path, 'cs')).toBe(true);
  }
  for (const path of [
    'https://evil.test/cs/crm',
    '//evil.test/cs/crm',
    '/en/crm',
    '/cs/../../evil',
    '/cs/%2e%2e/login',
    '/cs/%252e%252e/login',
    '/cs/../en/crm',
    String.raw`/cs/\evil`,
    '/cs/%5cevil',
    '/cs/%0d%0aevil',
    '/cs/login',
    '/cs/set-password?token=secret',
    '/cs/t=>{if("idle"!==_)return}',
    '/cs/t%3D%3E%7Bif%28%22idle%22%29%7D',
    '/cs/crm?password=secret',
    '/cs/crm?%70assword=secret',
    '/cs/crm?returnTo=%2Fcs%2Fcrm%3Fpassword%3Dy',
    '/cs/%',
  ]) {
    expect(isSafeSignInReturnPath(path, 'cs')).toBe(false);
  }
});

it('redacts every auth query value in Effect diagnostics, including OAuth and invitation state', () => {
  const query = new URLSearchParams([
    ['login', 'private-user'],
    ['password', 'private-secret'],
    ['state', 'private-state'],
    ['sig', 'private-signature'],
  ]);
  const raw = `https://stage.test/cs/login?${query.toString()}`;
  const logged = UrlParams.redactUrl(raw, authenticationQueryRedactions);
  for (const value of ['private-user', 'private-secret', 'private-state', 'private-signature']) {
    expect(logged).not.toContain(value);
  }
  expect(logged).toContain('/cs/login?');
});

it.effect('redacts real server and client request objects when the application logger formats them', () =>
  Effect.gen(function* requestLogRedaction() {
    const url = new URL('https://stage.test/cs/login');
    url.searchParams.set('password', 'request-log-probe');
    url.searchParams.set('state', 'oauth-log-probe');
    const entries: string[] = [];
    const logger = Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    });
    yield* Effect.logInfo(HttpServerRequest.fromWeb(new Request(url)), HttpClientRequest.get(url.href)).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(UrlParams.CurrentRedactedNames, authenticationQueryRedactions),
    );
    expect(entries).toHaveLength(1);
    expect(entries.join('')).not.toContain('request-log-probe');
    expect(entries.join('')).not.toContain('oauth-log-probe');
    expect(entries.join('')).toContain('/cs/login');
  }),
);
