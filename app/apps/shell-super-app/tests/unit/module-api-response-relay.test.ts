import { expect, it } from 'effect-rstest';

import {
  BLOCKED_RESPONSE_HEADERS,
  relayModuleResponse,
  relayedResponseHeaders,
} from '../../src/module-api/response-relay.ts';

const SELF = 'https://shell.example';
const ownerResponse = (headers: Record<string, string>) => new Response('payload', { headers, status: 200 });
const relayFor = (headers: Record<string, string>) => relayModuleResponse(ownerResponse(headers), SELF);

it('drops Set-Cookie so a module cannot write cookies for the Shell origin', () => {
  const relayed = relayFor({ 'content-type': 'text/plain', 'set-cookie': 'session=forged; Path=/' });
  expect(relayed.headers.get('set-cookie')).toBeNull();
  expect(relayed.headers.get('content-type')).toBe('text/plain');
});

it('keeps a relative or same-origin Location so an owner redirect still reaches the browser', () => {
  expect(relayFor({ location: '/catalog-api/redirect-target' }).headers.get('location')).toBe(
    '/catalog-api/redirect-target',
  );
  expect(relayFor({ location: `${SELF}/catalog-api/redirect-target` }).headers.get('location')).toBe(
    `${SELF}/catalog-api/redirect-target`,
  );
});

it('drops a cross-origin Location so the relay cannot become an off-origin redirect', () => {
  expect(relayFor({ location: 'https://evil.example/next' }).headers.get('location')).toBeNull();
  expect(relayFor({ location: '//evil.example/next' }).headers.get('location')).toBeNull();
});

it('forces a private cache policy and blocks active content on the Shell origin', () => {
  const relayed = relayFor({ 'cache-control': 'public, max-age=600', 'content-type': 'text/html' });
  expect(relayed.headers.get('cache-control')).toBe('no-store');
  expect(relayed.headers.get('vary')).toBe('authorization');
  expect(relayed.headers.get('x-content-type-options')).toBe('nosniff');
  expect(relayed.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
});

it('preserves content metadata a module legitimately needs', () => {
  const relayed = relayFor({
    'content-disposition': 'attachment; filename="report.csv"',
    'content-language': 'cs',
    'content-type': 'text/csv',
    etag: 'W/"1"',
  });
  expect(relayed.headers.get('content-disposition')).toBe('attachment; filename="report.csv"');
  expect(relayed.headers.get('content-language')).toBe('cs');
  expect(relayed.headers.get('content-type')).toBe('text/csv');
  expect(relayed.headers.get('etag')).toBe('W/"1"');
});

it('preserves an owner 401 authentication challenge', () => {
  const relayed = relayModuleResponse(
    new Response('', { headers: { 'www-authenticate': 'Bearer' }, status: 401 }),
    SELF,
  );
  expect(relayed.status).toBe(401);
  expect(relayed.headers.get('www-authenticate')).toBe('Bearer');
});

it('drops unlisted headers by default rather than forwarding them', () => {
  const relayed = relayedResponseHeaders(
    new Headers({ 'access-control-allow-origin': '*', 'content-type': 'text/plain', 'x-internal-debug': '1' }),
    SELF,
  );
  expect(relayed['access-control-allow-origin']).toBeUndefined();
  expect(relayed['x-internal-debug']).toBeUndefined();
  expect(relayed['content-type']).toBe('text/plain');
});

it('never relays a blocked header, even when the owner release sets one', () => {
  const relayed = relayedResponseHeaders(
    new Headers({ refresh: '0;url=https://evil.example', 'set-cookie': 'a=b', 'set-cookie2': 'c=d' }),
    SELF,
  );
  for (const blocked of BLOCKED_RESPONSE_HEADERS) {
    expect(relayed[blocked]).toBeUndefined();
  }
});
