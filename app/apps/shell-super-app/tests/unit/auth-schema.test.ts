import { expect, test } from '@rstest/core';
import { getTableColumns } from 'drizzle-orm';
import { AUTH_SCHEMA_NAME, AUTH_TABLE_INVENTORY, session } from '../../api/auth/db/schema.ts';
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

test('stores one nullable typed active tenant and legal entity on the private session row', () => {
  const { activeLegalEntityId, activeTenantId } = getTableColumns(session);
  expect(activeTenantId.name).toBe('active_tenant_id');
  expect(activeTenantId.columnType).toBe('PgUUID');
  expect(activeTenantId.dataType).toBe('string');
  expect(activeTenantId.notNull).toBe(false);
  expect(activeLegalEntityId.name).toBe('active_legal_entity_id');
  expect(activeLegalEntityId.columnType).toBe('PgUUID');
  expect(activeLegalEntityId.dataType).toBe('string');
  expect(activeLegalEntityId.notNull).toBe(false);
});

test('reports missing and unexpected authentication tables', () => {
  expect(
    compareAuthCatalog(['auth.user', 'auth.session', 'auth.account', 'auth.unexpected']),
  ).toEqual({
    missing: ['auth.verification'],
    unexpected: ['auth.unexpected'],
  });
});
