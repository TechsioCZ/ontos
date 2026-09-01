import { expect, test } from '@rstest/core';
import { getTableColumns } from 'drizzle-orm';
import {
  AUTH_SCHEMA_NAME,
  AUTH_TABLE_INVENTORY,
  apikey,
  session,
  supportImpersonationRecovery,
  user,
} from '../../api/auth/db/schema.ts';
import { compareAuthCatalog, expectedAuthTableCatalog } from '../../api/auth/db/catalog.ts';

test('owns the exact Better Auth model inside the auth schema', () => {
  expect(AUTH_SCHEMA_NAME).toBe('auth');
  expect(AUTH_TABLE_INVENTORY).toEqual([
    'user',
    'session',
    'account',
    'verification',
    'apikey',
    'support_impersonation_recovery',
  ]);
  expect(expectedAuthTableCatalog).toEqual([
    'auth.user',
    'auth.session',
    'auth.account',
    'auth.verification',
    'auth.apikey',
    'auth.support_impersonation_recovery',
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

test('matches the generated API Key and Admin plugin persistence fields', () => {
  expect(Object.keys(getTableColumns(apikey))).toEqual([
    'id',
    'configId',
    'name',
    'start',
    'referenceId',
    'prefix',
    'key',
    'refillInterval',
    'refillAmount',
    'lastRefillAt',
    'enabled',
    'rateLimitEnabled',
    'rateLimitTimeWindow',
    'rateLimitMax',
    'requestCount',
    'remaining',
    'lastRequest',
    'expiresAt',
    'createdAt',
    'updatedAt',
    'permissions',
    'metadata',
  ]);
  expect(Object.keys(getTableColumns(user))).toEqual(
    expect.arrayContaining(['role', 'banned', 'banReason', 'banExpires']),
  );
  expect(Object.keys(getTableColumns(session))).toEqual(
    expect.arrayContaining([
      'impersonatedBy',
      'impersonationReason',
      'impersonationActionId',
      'impersonationOriginalAuthBindingId',
      'impersonationOriginalPrincipalId',
      'impersonationOriginalSessionId',
      'impersonationTargetPrincipalId',
    ]),
  );
  expect(getTableColumns(session).impersonationActionId.columnType).toBe('PgText');
  expect(getTableColumns(session).impersonationTargetPrincipalId.columnType).toBe('PgUUID');
  expect(getTableColumns(session).impersonationOriginalAuthBindingId.columnType).toBe('PgUUID');
  expect(getTableColumns(session).impersonationOriginalPrincipalId.columnType).toBe('PgUUID');
  expect(getTableColumns(session).impersonationOriginalSessionId.columnType).toBe('PgText');
  expect(Object.keys(getTableColumns(supportImpersonationRecovery))).toEqual([
    'impersonationSessionId',
    'originalAuthBindingId',
    'originalPrincipalId',
    'originalSessionId',
    'tenantId',
    'targetPrincipalId',
    'actionId',
    'reason',
    'createdAt',
  ]);
});

test('reports missing and unexpected authentication tables', () => {
  expect(
    compareAuthCatalog(['auth.user', 'auth.session', 'auth.account', 'auth.unexpected']),
  ).toEqual({
    missing: ['auth.apikey', 'auth.support_impersonation_recovery', 'auth.verification'],
    unexpected: ['auth.unexpected'],
  });
});
