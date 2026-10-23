import { mcp } from '@better-auth/mcp';
import { getAuthTables } from 'better-auth/db';
import { jwt } from 'better-auth/plugins/jwt';
import { getColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, test } from 'effect-rstest';

import { compareAuthCatalog, expectedAuthTableCatalog } from '../../api/auth/db/catalog.ts';
import {
  AUTH_SCHEMA_NAME,
  AUTH_TABLE_INVENTORY,
  account,
  apikey,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  session,
  supportImpersonationRecovery,
  user,
} from '../../api/auth/db/schema.ts';

test('owns the exact Better Auth model inside the auth schema', () => {
  expect(AUTH_SCHEMA_NAME).toBe('auth');
  expect(AUTH_TABLE_INVENTORY).toEqual([
    'user',
    'session',
    'account',
    'verification',
    'apikey',
    'support_impersonation_recovery',
    'jwks',
    'oauth_client',
    'oauth_resource',
    'oauth_client_resource',
    'oauth_refresh_token',
    'oauth_access_token',
    'oauth_consent',
    'oauth_client_assertion',
  ]);
  expect(expectedAuthTableCatalog).toEqual([
    'auth.user',
    'auth.session',
    'auth.account',
    'auth.verification',
    'auth.apikey',
    'auth.support_impersonation_recovery',
    'auth.jwks',
    'auth.oauth_client',
    'auth.oauth_resource',
    'auth.oauth_client_resource',
    'auth.oauth_refresh_token',
    'auth.oauth_access_token',
    'auth.oauth_consent',
    'auth.oauth_client_assertion',
  ]);
});

test('declares every Better Auth OAuth provider and JWKS field', () => {
  const tables = getAuthTables({
    plugins: [
      jwt(),
      mcp({ consentPage: '/cs/pripojit/souhlas', loginPage: '/cs/login', resource: 'http://localhost:3020/mcp' }),
    ],
  });
  const cases = [
    ['jwks', jwks],
    ['oauthClient', oauthClient],
    ['oauthResource', oauthResource],
    ['oauthClientResource', oauthClientResource],
    ['oauthRefreshToken', oauthRefreshToken],
    ['oauthAccessToken', oauthAccessToken],
    ['oauthConsent', oauthConsent],
    ['oauthClientAssertion', oauthClientAssertion],
  ] as const;
  for (const [model, table] of cases) {
    expect(Object.keys(getColumns(table)).toSorted()).toEqual(
      ['id', ...Object.keys(tables[model]?.fields ?? {})].toSorted(),
    );
  }
});

test('keys accounts on the Better Auth provider identity and keeps only a nullable legacy issuer', () => {
  const { issuer, ...columns } = getColumns(account);
  expect(Object.keys(columns).toSorted()).toEqual(
    ['id', ...Object.keys(getAuthTables({})['account']?.fields ?? {})].toSorted(),
  );
  expect(issuer.notNull).toBe(false);
  expect(
    getTableConfig(account)
      .indexes.filter((index) => index.config.unique)
      .map((index) => index.config.columns.map((column) => ('name' in column ? column.name : undefined))),
  ).toContainEqual(['provider_id', 'account_id']);
});

test('stores one nullable typed active tenant and legal entity on the private session row', () => {
  const { activeContextKind, activeLegalEntityId, activeTenantId } = getColumns(session);
  expect(activeContextKind.name).toBe('active_context_kind');
  expect(activeContextKind.notNull).toBe(true);
  expect(activeContextKind.default).toBe('company');
  expect(getTableConfig(session).checks.map(({ name }) => name)).toEqual([
    'auth_session_context_kind_check',
    'auth_session_tenant_context_check',
  ]);
  expect(activeTenantId.name).toBe('active_tenant_id');
  expect(activeTenantId.columnType).toBe('PgUUID');
  expect(activeTenantId.getSQLType()).toBe('uuid');
  expect(activeTenantId.notNull).toBe(false);
  expect(activeLegalEntityId.name).toBe('active_legal_entity_id');
  expect(activeLegalEntityId.columnType).toBe('PgUUID');
  expect(activeLegalEntityId.getSQLType()).toBe('uuid');
  expect(activeLegalEntityId.notNull).toBe(false);
});

test('matches the generated API Key and Admin plugin persistence fields', () => {
  expect(Object.keys(getColumns(apikey))).toEqual([
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
  expect(Object.keys(getColumns(user))).toEqual(expect.arrayContaining(['role', 'banned', 'banReason', 'banExpires']));
  expect(Object.keys(getColumns(session))).toEqual(
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
  expect(getColumns(session).impersonationActionId.columnType).toBe('PgText');
  expect(getColumns(session).impersonationTargetPrincipalId.columnType).toBe('PgUUID');
  expect(getColumns(session).impersonationOriginalAuthBindingId.columnType).toBe('PgUUID');
  expect(getColumns(session).impersonationOriginalPrincipalId.columnType).toBe('PgUUID');
  expect(getColumns(session).impersonationOriginalSessionId.columnType).toBe('PgText');
  expect(Object.keys(getColumns(supportImpersonationRecovery))).toEqual([
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
    compareAuthCatalog(['auth.user', 'auth.session', 'auth.account', 'auth.unexpected', 'auth.unexpected']),
  ).toEqual({
    missing: [
      'auth.apikey',
      'auth.jwks',
      'auth.oauth_access_token',
      'auth.oauth_client',
      'auth.oauth_client_assertion',
      'auth.oauth_client_resource',
      'auth.oauth_consent',
      'auth.oauth_refresh_token',
      'auth.oauth_resource',
      'auth.support_impersonation_recovery',
      'auth.verification',
    ],
    unexpected: ['auth.unexpected'],
  });
});

test('accepts unordered duplicate auth table rows without mutating the inventory', () => {
  expect(compareAuthCatalog([...expectedAuthTableCatalog.toReversed(), 'auth.user'])).toEqual({
    missing: [],
    unexpected: [],
  });
  expect(compareAuthCatalog([])).toEqual({
    missing: expectedAuthTableCatalog.toSorted(),
    unexpected: [],
  });
});
