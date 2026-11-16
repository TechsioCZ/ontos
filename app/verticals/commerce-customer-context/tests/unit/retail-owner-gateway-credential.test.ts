import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { Crypto, Effect, Redacted, Result, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import type { GatewayDelegationRequest } from '@app/shared-contracts/gateway-context-server';

import { acquireRetailOwnerCredential } from '../../src/enrollment/journeys/retail-owner-gateway-credential.ts';

interface DelegatedState {
  readonly requests: GatewayDelegationRequest[];
  token: string;
}
const delegated = rs.hoisted((): DelegatedState => ({ requests: [], token: '' }));
rs.mock('@app/shared-contracts/gateway-context-server', () => ({
  acquireDelegatedGatewayContext: (request: GatewayDelegationRequest) => {
    delegated.requests.push(request);
    return Effect.succeed({
      apiBaseUrl: 'https://shell.example.test/party-registry-api',
      authorization: `Bearer ${delegated.token}`,
      compositionRevision: 'c'.repeat(64),
      expiresAt: 1_700_000_300,
    });
  },
  GatewayDelegationSourceError: class GatewayDelegationSourceError extends Schema.TaggedError<GatewayDelegationSourceError>()(
    'GatewayDelegationSourceError',
    { reason: Schema.String },
  ) {},
}));

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const subjectPrincipalId = '30000000-0000-4000-8000-000000000001';
const actionInvocationId = '31000000-0000-4000-8000-000000000001';
const compositionRevision = 'c'.repeat(64);
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => new Uint8Array(size).fill(1),
});
const originator = { actionInvocationId, compositionRevision, tenantId };

/** A version 3 assertion as the Shell issues it, with overridable actor and scope claims. */
const claimsFor = (overrides: { readonly act?: string; readonly tenant?: string } = {}) => ({
  act: {
    appId: overrides.act ?? 'commerce-customer-context',
    buildMarker: 'ccc-build-1',
    principalId: '40000000-0000-4000-8000-000000000001',
  },
  aud: 'party-registry',
  compositionRevision,
  exp: 1_700_000_300,
  iat: 1_700_000_000,
  iss: 'shell-super-app',
  jti: '50000000-0000-4000-8000-000000000001',
  principal: {
    authBindingId: '60000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:enrollment-originator',
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId,
    principalId: subjectPrincipalId,
    tenantId: overrides.tenant ?? tenantId,
  },
  sub: subjectPrincipalId,
  targetBuildMarker: 'party-build-1',
  ver: 3,
});

type AssertionClaims = ReturnType<typeof claimsFor>;
const tokenFor = (claims: AssertionClaims) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

const request = {
  audience: 'party-registry' as const,
  crypto,
  legalEntityId,
  originator,
  requestCorrelation: 'enrollment-owner-test',
};

it.effect('acts for the originator and accepts an assertion issued to this module for the Attempt scope', () =>
  Effect.gen(function* acceptsAttemptScope() {
    delegated.token = tokenFor(claimsFor());
    const owner = yield* acquireRetailOwnerCredential(request);
    expect(owner.baseUrl.pathname).toBe('/party-registry-api');
    expect(Redacted.value(owner.credential)).toBe(`Bearer ${delegated.token}`);
    expect(delegated.requests.at(-1)).toMatchObject({
      audience: 'party-registry',
      callingAppId: 'commerce-customer-context',
      legalEntityScope: 'subject',
      requestCorrelation: 'enrollment-owner-test',
      subject: { _tag: 'Originator', actionInvocationId, compositionRevision, legalEntityId, tenantId },
    });
  }),
);

it.effect('refuses an assertion issued for another Legal Entity than the Attempt names', () =>
  Effect.gen(function* refusesOtherLegalEntity() {
    delegated.token = tokenFor(claimsFor());
    const failure = yield* Effect.result(
      acquireRetailOwnerCredential({ ...request, legalEntityId: '20000000-0000-4000-8000-000000000009' }),
    );
    expect(Result.isFailure(failure)).toBe(true);
  }),
);

it.effect('refuses an assertion whose calling module is not Commerce Customer Context', () =>
  Effect.gen(function* refusesOtherCaller() {
    delegated.token = tokenFor(claimsFor({ act: 'pricing' }));
    const failure = yield* Effect.result(acquireRetailOwnerCredential(request));
    expect(Result.isFailure(failure)).toBe(true);
  }),
);

it.effect('refuses an assertion issued for another Tenant than the originator', () =>
  Effect.gen(function* refusesOtherTenant() {
    delegated.token = tokenFor(claimsFor({ tenant: '10000000-0000-4000-8000-000000000009' }));
    const failure = yield* Effect.result(acquireRetailOwnerCredential(request));
    expect(Result.isFailure(failure)).toBe(true);
  }),
);
