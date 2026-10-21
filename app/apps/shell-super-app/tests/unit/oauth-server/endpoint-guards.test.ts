// @rstest-environment node
import { createHash } from 'node:crypto';

import { expect, test } from 'effect-rstest';

import { classifyRefreshToken, refreshTokenStorageKey } from '../../../api/auth/oauth-server/endpoint-guards.ts';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const at = (offsetSeconds: number) => new Date(NOW + offsetSeconds * 1000);

test('a live or unknown refresh token is left to Better Auth', () => {
  expect(classifyRefreshToken(undefined, NOW)).toBe('pass');
  expect(classifyRefreshToken({ revoked: null, rotatedAt: null, rotationReplayExpiresAt: null }, NOW)).toBe('pass');
});

test('a rotated token inside the 30 s replay grace is left to Better Auth', () => {
  expect(classifyRefreshToken({ revoked: at(-10), rotatedAt: at(-10), rotationReplayExpiresAt: at(20) }, NOW)).toBe(
    'pass',
  );
});

test('a rotated token after the grace is reuse', () => {
  expect(classifyRefreshToken({ revoked: at(-40), rotatedAt: at(-40), rotationReplayExpiresAt: at(-10) }, NOW)).toBe(
    'reused',
  );
  expect(classifyRefreshToken({ revoked: at(-40), rotatedAt: at(-40), rotationReplayExpiresAt: null }, NOW)).toBe(
    'reused',
  );
});

test('a revoked token that was never rotated is dead, not reuse', () => {
  expect(classifyRefreshToken({ revoked: at(-5), rotatedAt: null, rotationReplayExpiresAt: null }, NOW)).toBe('dead');
});

test('the storage key matches Better Auth hashed storage (unpadded base64url SHA-256)', () => {
  const expected = createHash('sha256').update('abc').digest('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  expect(refreshTokenStorageKey('abc')).toBe(expected);
});
