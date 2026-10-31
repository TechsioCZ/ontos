import { expect, test } from 'effect-rstest';

import { isSameOriginRequest } from '../../../api/oauth-connections/request-origin.ts';

const ISSUER_ORIGIN = 'http://localhost:3020';

test('isSameOriginRequest accepts the shell origin and same-origin fetches without Origin', () => {
  expect(isSameOriginRequest({ host: 'localhost:3020', origin: 'http://localhost:3020' }, ISSUER_ORIGIN)).toBe(true);
  expect(isSameOriginRequest({ host: 'ontos.example', origin: 'https://ontos.example' }, ISSUER_ORIGIN)).toBe(true);
  expect(isSameOriginRequest({ host: 'localhost:3020', 'sec-fetch-site': 'same-origin' }, ISSUER_ORIGIN)).toBe(true);
});

test('isSameOriginRequest refuses a request that names no origin', () => {
  expect(isSameOriginRequest({ host: 'localhost:3020' }, ISSUER_ORIGIN)).toBe(false);
  expect(isSameOriginRequest({ host: 'localhost:3020', 'sec-fetch-site': 'none' }, ISSUER_ORIGIN)).toBe(false);
});

test('isSameOriginRequest refuses cross-site Origin and Sec-Fetch-Site', () => {
  expect(isSameOriginRequest({ host: 'localhost:3020', origin: 'https://evil.example' }, ISSUER_ORIGIN)).toBe(false);
  expect(isSameOriginRequest({ host: 'localhost:3020', origin: 'null' }, ISSUER_ORIGIN)).toBe(false);
  expect(isSameOriginRequest({ host: 'localhost:3020', 'sec-fetch-site': 'cross-site' }, ISSUER_ORIGIN)).toBe(false);
});
