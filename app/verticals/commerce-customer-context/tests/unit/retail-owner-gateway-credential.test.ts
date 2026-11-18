import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { ConfigProvider, Crypto, Effect, Redacted, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import { acquireRetailOwnerCredential } from '../../src/enrollment/journeys/retail-owner-gateway-credential.ts';

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

const delegatedPath = '/shell-super-app-api/auth/delegated/gateway-context';
const shellConfiguration = ConfigProvider.fromUnknown({
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});

/**
 * The actual delegated Shell client runs against this fake Shell peer, which answers every delegation with
 * the Party Registry base path and the scripted assertion as its bearer.
 */
const acquireWith = (token: string, input: Parameters<typeof acquireRetailOwnerCredential>[0]) => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const sent = new Request(url, init);
    requests.push(sent);
    return Promise.resolve(
      new URL(sent.url).pathname === delegatedPath
        ? Response.json({
            apiBaseUrl: '/party-registry-api',
            compositionRevision,
            expiresAt: 1_700_000_300,
            token,
          })
        : Response.json({ detail: 'Unknown route' }, { status: 404 }),
    );
  };
  // The caller's own key, handed over the way the host does; nothing reads a module key from configuration.
  return holdTestModuleCredentials({ 'commerce-customer-context': 'ccc-fixture-module-key' }).pipe(
    Effect.andThen(acquireRetailOwnerCredential(input)),
    Effect.provideService(ConfigProvider.ConfigProvider, shellConfiguration),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.map((owner) => ({ owner, requests })),
  );
};

/** A delegation the actual client sent, decoded as the Shell reads it. */
const readDelegation = (sent: Request) =>
  Effect.promise(() => sent.clone().text()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(GatewayDelegatedContextRequestSchema))),
  );

const request = {
  audience: 'party-registry' as const,
  crypto,
  legalEntityId,
  originator,
  requestCorrelation: 'enrollment-owner-test',
};

it.effect('acts for the originator and accepts an assertion issued to this module for the Attempt scope', () =>
  Effect.gen(function* acceptsAttemptScope() {
    const token = tokenFor(claimsFor());
    const { owner, requests } = yield* acquireWith(token, request);
    expect(owner.baseUrl.pathname).toBe('/party-registry-api');
    expect(Redacted.value(owner.credential)).toBe(`Bearer ${token}`);
    const delegated = requests.filter((sent) => new URL(sent.url).pathname === delegatedPath);
    expect(delegated.map((sent) => sent.headers.get('x-correlation-id'))).toEqual(['enrollment-owner-test']);
    expect(yield* Effect.all(delegated.map((sent) => readDelegation(sent)))).toMatchObject([
      {
        audience: 'party-registry',
        compositionRevision,
        legalEntityScope: 'subject',
        subject: { _tag: 'Originator', actionInvocationId, legalEntityId, tenantId },
      },
    ]);
  }),
);

it.effect('refuses an assertion issued for another Legal Entity than the Attempt names', () =>
  Effect.gen(function* refusesOtherLegalEntity() {
    const failure = yield* Effect.result(
      acquireWith(tokenFor(claimsFor()), { ...request, legalEntityId: '20000000-0000-4000-8000-000000000009' }),
    );
    expect(Result.isFailure(failure)).toBe(true);
  }),
);

it.effect('refuses an assertion whose calling module is not Commerce Customer Context', () =>
  Effect.gen(function* refusesOtherCaller() {
    const failure = yield* Effect.result(acquireWith(tokenFor(claimsFor({ act: 'pricing' })), request));
    expect(Result.isFailure(failure)).toBe(true);
  }),
);

it.effect('refuses an assertion issued for another Tenant than the originator', () =>
  Effect.gen(function* refusesOtherTenant() {
    const failure = yield* Effect.result(
      acquireWith(tokenFor(claimsFor({ tenant: '10000000-0000-4000-8000-000000000009' })), request),
    );
    expect(Result.isFailure(failure)).toBe(true);
  }),
);
