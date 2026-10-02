import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { SupportedGatewayContextClaimsSchema } from '../../src/gateway-context.ts';

const principalId = '40000000-0000-4000-8000-000000000001';
const principal = {
  authBindingId: '70000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:legacy-staff-id',
  authMethod: 'session',
  principalId,
  tenantId: '30000000-0000-4000-8000-000000000001',
};
const staff = {
  aud: 'test-app',
  compositionRevision: 'a'.repeat(64),
  exp: 1300,
  iat: 1000,
  iss: 'test-shell',
  jti: '50000000-0000-4000-8000-000000000001',
  principal,
  sub: principalId,
  targetBuildMarker: 'test-app-release-2026-10-02',
  ver: 1,
};
const external = {
  ...staff,
  principal: {
    ...principal,
    authContextRef: 'opaque-session-evidence',
    authenticationNamespaceId: 'test.third-provider.realm',
  },
  ver: 2,
};
const decode = Schema.decodeUnknownSync(SupportedGatewayContextClaimsSchema, { onExcessProperty: 'error' });

it('admits release-bound staff v1 and third-namespace v2 assertions', () => {
  expect(decode(staff)).toEqual(staff);
  expect(decode(external)).toEqual(external);
});

it('rejects missing namespace, wrong subject and changed assertion lifetime', () => {
  expect(() => decode({ ...staff, ver: 2 })).toThrow();
  expect(() => decode({ ...external, sub: staff.jti })).toThrow();
  expect(() => decode({ ...external, exp: 1301 })).toThrow();
  expect(() => decode({ ...external, ver: 1 })).toThrow();
});

it('rejects unbound and malformed release identities for both authentication variants', () => {
  for (const claims of [staff, external]) {
    const { compositionRevision: _compositionRevision, ...withoutRevision } = claims;
    const { targetBuildMarker: _targetBuildMarker, ...withoutTargetRelease } = claims;
    expect(() => decode(withoutRevision)).toThrow();
    expect(() => decode(withoutTargetRelease)).toThrow();
    for (const compositionRevision of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      `sha256:${'a'.repeat(64)}`,
    ]) {
      expect(() => decode({ ...claims, compositionRevision })).toThrow();
    }
    expect(decode({ ...claims, targetBuildMarker: 'a'.repeat(200) })).toEqual({
      ...claims,
      targetBuildMarker: 'a'.repeat(200),
    });
    for (const targetBuildMarker of ['', 'a'.repeat(201), ' ', ' release', 'release ']) {
      expect(() => decode({ ...claims, targetBuildMarker })).toThrow();
    }
  }
});

it('rejects admission proofs, provider details and application identity in reusable gateway claims', () => {
  expect(() => decode({ ...external, admissionEvidence: {} })).toThrow();
  for (const field of [
    'providerSubjectId',
    'emailVerified',
    'applicationPrincipalId',
    'applicationAuthBindingId',
    'sessionToken',
  ]) {
    expect(() => decode({ ...external, principal: { ...external.principal, [field]: 'forbidden' } })).toThrow();
  }
});
