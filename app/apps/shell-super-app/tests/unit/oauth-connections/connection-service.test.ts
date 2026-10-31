import { expect, test } from 'effect-rstest';

import { evaluateLiveChecks, revokedStatusFor } from '../../../api/oauth-connections/connection-service.ts';
import type { LiveFacts } from '../../../api/oauth-connections/connection-service.ts';

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
