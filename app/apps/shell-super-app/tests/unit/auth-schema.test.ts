import { expect, test } from '@rstest/core';
import { AUTH_SCHEMA_NAME, AUTH_TABLE_INVENTORY } from '../../api/auth/db/schema.ts';
import { compareAuthCatalog, expectedAuthTableCatalog } from '../../api/auth/db/catalog.ts';

test('owns the exact Better Auth model inside the auth schema', () => {
  expect(AUTH_SCHEMA_NAME).toBe('auth');
  expect(AUTH_TABLE_INVENTORY).toEqual(['user', 'session', 'account', 'verification']);
  expect(expectedAuthTableCatalog).toEqual([
    'auth.user',
    'auth.session',
    'auth.account',
    'auth.verification',
  ]);
});

test('reports missing and unexpected authentication tables', () => {
  expect(
    compareAuthCatalog(['auth.user', 'auth.session', 'auth.account', 'auth.unexpected']),
  ).toEqual({
    missing: ['auth.verification'],
    unexpected: ['auth.unexpected'],
  });
});
