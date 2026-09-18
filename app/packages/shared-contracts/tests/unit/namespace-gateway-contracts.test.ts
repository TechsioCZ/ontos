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
const legacy = {
  aud: 'test-app',
  exp: 1300,
  iat: 1000,
  iss: 'test-shell',
  jti: '50000000-0000-4000-8000-000000000001',
  principal,
  sub: principalId,
  ver: 1,
};
const external = {
  ...legacy,
  principal: {
    ...principal,
    authContextRef: 'opaque-session-evidence',
    authenticationNamespaceId: 'test.third-provider.realm',
  },
  ver: 2,
};
const decode = Schema.decodeUnknownSync(SupportedGatewayContextClaimsSchema, { onExcessProperty: 'error' });

it('preserves unchanged staff v1 and admits third-namespace v2 without provider grammar or application fields', () => {
  expect(decode(legacy)).toEqual(legacy);
  expect(decode(external)).toEqual(external);
});

it('rejects missing namespace, wrong subject and changed assertion lifetime', () => {
  expect(() => decode({ ...legacy, ver: 2 })).toThrow();
  expect(() => decode({ ...external, sub: legacy.jti })).toThrow();
  expect(() => decode({ ...external, exp: 1301 })).toThrow();
  expect(() => decode({ ...external, ver: 1 })).toThrow();
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
