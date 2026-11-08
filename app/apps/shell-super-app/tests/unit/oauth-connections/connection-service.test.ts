import { expect, test } from 'effect-rstest';
import { ConnectionModuleIdSchema } from '@app/shared-contracts/oauth-connections';

import {
  connectionScopeOf,
  evaluateLiveChecks,
  revokedStatusFor,
} from '../../../api/oauth-connections/connection-service.ts';
import type { LiveFacts } from '../../../api/oauth-connections/connection-service.ts';
import type { GrantRow } from '../../../api/oauth-connections/types.ts';

const human: LiveFacts = {
  actingKind: 'human',
  actingPrincipalStatus: 'active',
  agentInCompany: true,
  bindingStatus: 'active',
  grantStatus: 'active',
  hasCompanyAccess: true,
  operatorHolds: true,
  userBanned: false,
  userEmailVerified: true,
  userExists: true,
  userPrincipalStatus: 'active',
};

const agent: LiveFacts = { ...human, actingKind: 'agent', actingPrincipalStatus: 'active' };

test('a complete human fact set passes every live check', () => {
  expect(evaluateLiveChecks(human)).toEqual({ ok: true });
});

test('a revoked grant fails as grant_inactive without revoking again', () => {
  expect(evaluateLiveChecks({ ...human, grantStatus: 'revoked' })).toEqual({
    code: 'grant_inactive',
    ok: false,
    revoke: null,
  });
});

test('an agent without operate rights fails as operator_removed and revokes', () => {
  expect(evaluateLiveChecks({ ...agent, operatorHolds: false })).toEqual({
    code: 'operator_removed',
    ok: false,
    revoke: 'operator_removed',
  });
});

test('a disabled acting agent fails as agent_disabled and revokes', () => {
  expect(evaluateLiveChecks({ ...agent, actingPrincipalStatus: 'disabled' })).toEqual({
    code: 'agent_disabled',
    ok: false,
    revoke: 'agent_disabled',
  });
});

test('a human without company access fails as membership_missing without revoking', () => {
  expect(evaluateLiveChecks({ ...human, hasCompanyAccess: false })).toEqual({
    code: 'membership_missing',
    ok: false,
    revoke: null,
  });
});

test('a banned user fails as user_disabled and revokes', () => {
  expect(evaluateLiveChecks({ ...human, userBanned: true })).toEqual({
    code: 'user_disabled',
    ok: false,
    revoke: 'user_disabled',
  });
});

test('an unverified user fails as user_disabled without revoking', () => {
  expect(evaluateLiveChecks({ ...human, userEmailVerified: false })).toEqual({
    code: 'user_disabled',
    ok: false,
    revoke: null,
  });
});

test('a disabled auth binding fails as binding_inactive without revoking', () => {
  expect(evaluateLiveChecks({ ...human, bindingStatus: 'disabled' })).toEqual({
    code: 'binding_inactive',
    ok: false,
    revoke: null,
  });
});

test('an agent outside the company fails as agent_disabled after the membership check', () => {
  expect(evaluateLiveChecks({ ...agent, agentInCompany: false })).toEqual({
    code: 'agent_disabled',
    ok: false,
    revoke: 'agent_disabled',
  });
});

test('revokedStatusFor keeps superseded only for the superseded reason', () => {
  expect(revokedStatusFor('superseded')).toBe('superseded');
  expect(revokedStatusFor('user')).toBe('revoked');
  expect(revokedStatusFor('operator_removed')).toBe('revoked');
});

const grant: GrantRow = {
  actingKind: 'human',
  actingPrincipalId: '20000000-0000-4000-8000-000000000001',
  authBindingId: '40000000-0000-4000-8000-000000000001',
  clientHost: 'example.test',
  clientId: 'https://example.test/client.json',
  clientKind: 'loopback',
  clientLogoUri: null,
  clientName: 'Test connection',
  consentedAt: new Date(0),
  consentId: 'consent-1',
  createdAt: new Date(0),
  grantId: '50000000-0000-4000-8000-000000000001',
  lastUsedAt: null,
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  modules: 'all',
  profileId: '60000000-0000-4000-8000-000000000001',
  revokedAt: null,
  revokedByPrincipalId: null,
  revokeReason: null,
  sessionId: 'session-1',
  status: 'active',
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: 'user-1',
  userPrincipalId: '20000000-0000-4000-8000-000000000001',
  writePolicy: 'read_only',
};

test('a connection scope preserves the persisted all-module ceiling and exact grant identity', () => {
  const scope = connectionScopeOf(grant);
  expect(scope).toEqual({
    authContextRef: `oauth-grant:${grant.grantId}`,
    authMethod: 'oauth_connection',
    connection: {
      clientId: grant.clientId,
      clientName: grant.clientName,
      grantId: grant.grantId,
      modules: 'all',
      writePolicy: 'read_only',
    },
    correlationId: `oauth-connection:${grant.grantId}`,
    legalEntityId: grant.legalEntityId,
    principalId: grant.actingPrincipalId,
    tenantId: grant.tenantId,
  });
  expect(Object.isFrozen(scope)).toBe(true);
});

test('explicit connection module ceilings are copied without adding authority', () => {
  const modules: GrantRow['modules'] = [{ access: 'read', moduleId: ConnectionModuleIdSchema.make('work.tasks') }];
  const scope = connectionScopeOf({ ...grant, clientName: 'x'.repeat(220), modules });
  expect(scope.connection?.modules).toEqual(modules);
  expect(scope.connection?.modules).not.toBe(modules);
  expect(scope.connection?.clientName).toHaveLength(200);
  expect(scope.connection?.writePolicy).toBe('read_only');
});

test('an agent scope retains the original OAuth owner without inventing a binding or session', () => {
  const actingPrincipalId = '20000000-0000-4000-8000-000000000002';
  const scope = connectionScopeOf({ ...grant, actingKind: 'agent', actingPrincipalId });
  expect(scope.principalId).toBe(actingPrincipalId);
  expect(scope.delegatedByPrincipalId).toBe(grant.userPrincipalId);
  expect(scope.authMethod).toBe('oauth_connection');
  expect(scope.authContextRef).toBe(`oauth-grant:${grant.grantId}`);
  expect(scope.authBindingId).toBeUndefined();
  expect(scope.authenticationNamespaceId).toBeUndefined();
});
