import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import {
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayActor,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import {
  makeApplicationCompositionSnapshotFixture,
  makeOwnerApplicationCompositionFixture,
  makePublishedApplicationCompositionSnapshotFixture,
} from '@app/core-runtime/testing/module-contract';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { NodeCrypto } from '@effect/platform-node';
import { Clock, ConfigProvider, DateTime, Effect, Layer, Match, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import { CommerceAuthenticationNamespaceRegistryLive } from '../../api/portal-auth/authentication-namespace-registry.ts';
import {
  CustomerOwnPortalReadInputSchema,
  UpdateOwnCustomerProfilePayloadSchema,
} from '../../shared/portal-auth/own-session.ts';
import type { CustomerOwnProfile } from '../../shared/portal-auth/profile-api.ts';
import { ownPortalScope } from '../../api/portal-auth/own/own-portal-scope.ts';
import { readDirectCustomerParty } from '../../api/portal-auth/profile/party-profile.ts';
import { profileUnavailable } from '../../api/portal-auth/profile/problems.ts';
import { CustomerOwnProfileUpdateExchange } from '../../api/portal-auth/profile/update-exchange.ts';
import { updateOwnCustomerProfileAction } from '../../src/actions/update-own-customer-profile.action.ts';
import { CommercePortalAuthAudit } from '../../src/portal-auth/audit/audit.ts';
import type { CommercePortalAuthAuditEvent } from '../../src/portal-auth/audit/audit-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { customerOwnProfileRead } from '../../src/portal-auth/reads/customer-own-profile.read.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const storefrontPrincipalId = '30000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const issuer = 'https://own-profile-shell.example.test';
const profile = {
  contactEmail: 'own-customer@example.test',
  displayName: 'Own Customer',
  phone: '+420777123456',
  version: 'b'.repeat(64),
};
const modulePrincipalId = '31000000-0000-4000-8000-000000000001';
const update = { ...profile, contactEmail: 'changed-customer@example.test', displayName: 'Changed Customer' };
const updatedProfile = { ...update, version: 'c'.repeat(64) };
const input = Schema.decodeUnknownSync(CustomerOwnPortalReadInputSchema)({
  session: {
    authBindingId: '50000000-0000-4000-8000-000000000001',
    customerPrincipalId: '60000000-0000-4000-8000-000000000001',
    partyId,
    providerSubjectId: 'own-profile-provider-subject',
    sessionRefDigest: 'a'.repeat(64),
  },
});
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '70000000-0000-4000-8000-000000000001',
  authContextRef: 'api-key:registered-storefront',
  authenticationNamespaceId: 'ontos.staff.better-auth.v1',
  authMethod: 'api_key',
  legalEntityId,
  principalId: storefrontPrincipalId,
  tenantId,
});
const enrollment = defineDatabaseIdentityEnrollment([
  {
    moduleKey: 'commerce.customer-context',
    policyPrefix: 'own_profile_test',
    request: {
      cloudflareHyperdrive: null,
      gatewayScopeAudiences: ['commerce-customer-context'],
      handlesBearerAssertions: true,
      id: 'ccc_own_profile_test',
      ownerModuleKey: 'commerce.customer-context',
      registersGatewayScopeGrants: false,
      role: 'ccc_own_profile_test',
      runsActions: true,
      scopeAuthority: 'gateway_grant',
      urlKey: 'CCC_OWN_PROFILE_TEST_DATABASE_URL',
    },
    schemas: ['commerce_customer_context'],
    worker: {
      cloudflareHyperdrive: null,
      gatewayScopeAudiences: [],
      handlesBearerAssertions: false,
      id: 'ccc_own_profile_test_worker',
      ownerModuleKey: 'commerce.customer-context',
      registersGatewayScopeGrants: false,
      role: 'ccc_own_profile_test_worker',
      runsActions: false,
      scopeAuthority: 'session_setting',
      urlKey: 'CCC_OWN_PROFILE_TEST_WORKER_DATABASE_URL',
    },
  },
]);

interface ResponseFixture {
  readonly partyId?: string;
  readonly tenantId?: string;
}

const makeFixture = Effect.fn('OwnProfileDelegation.fixture')(function* makeFixture(response: ResponseFixture = {}) {
  const { owner, party } = yield* Effect.all(
    {
      owner: makeOwnerApplicationCompositionFixture({
        appId: 'commerce-customer-context',
        buildMarker: ultramodernApiMarker.buildMarker,
        ownerRegistration: commerceCustomerContextRegistration,
      }),
      party: makeApplicationCompositionSnapshotFixture(['party-registry'], ultramodernApiMarker.buildMarker),
    },
    { concurrency: 1 },
  );
  const { shell } = owner.snapshot.composition;
  // Retain the real CCC registration's safe operation projection. Party's HTTP receiver
  // is isolated here; no other owner's private registration or production source is imported.
  const snapshot = yield* makePublishedApplicationCompositionSnapshotFixture({
    contractInputs: [...owner.snapshot.composition.modules, ...party.composition.modules].map(
      ({ contractDocument }) => contractDocument,
    ),
    publishedShellRuntime: {
      document: JSON.stringify({
        contributionAbi: shell.contributionAbi,
        coreCapabilities: shell.coreCapabilities,
        deployment: shell.deployment,
        schemaVersion: '2',
      }),
      receiverDeployment: shell.deployment,
    },
    validityMs: 300_000,
  });
  const pair = yield* Effect.promise(() => generateKeyPair('Ed25519'));
  const publicJwk = yield* Effect.promise(() => exportJWK(pair.publicKey));
  const verification = {
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
      keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'own-profile-test', use: 'sig' }],
    }),
  };
  const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const sign = (audience: string, jti: string) =>
    Effect.promise(() =>
      new SignJWT({
        compositionRevision: snapshot.composition.revision,
        principal,
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: 2,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'own-profile-test', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(storefrontPrincipalId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .setJti(jti)
        .sign(pair.privateKey),
    );
  const source = yield* sign('commerce-customer-context', '80000000-0000-4000-8000-000000000001');
  // Only the genuine receiving verifier creates provenance; no test trust-stamping helper is used.
  const verified = yield* bindGatewayPrincipalVerifier('commerce-customer-context', ultramodernApiMarker)
    .verifyAndRedeem(Redacted.make(`Bearer ${source}`), {
      environment: verification,
      redemption: { consume: () => Effect.void },
    })
    .pipe(
      Effect.provideService(
        ActiveApplicationCompositionService,
        makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
      ),
    );
  const scope = preserveSystemPrincipalContextTrust(verified, {
    ...verified,
    correlationId: 'customer-own-profile-delegation',
  });
  const rawPartyToken = yield* sign('party-registry', '81000000-0000-4000-8000-000000000001');
  const requests: Request[] = [];
  let issuanceCount = 0;
  let currentProfile = profile;
  const redeemed = new Set<string>();
  const fakeFetch: typeof fetch = async (target, init) => {
    const sent = new Request(target, init);
    requests.push(sent);
    if (sent.url.endsWith('/auth/api-key/gateway-context')) {
      return Response.json({
        apiBaseUrl: '/party-registry-api',
        compositionRevision: snapshot.composition.revision,
        expiresAt: issuedAt + 300,
        token: rawPartyToken,
      });
    }
    if (sent.url.endsWith('/auth/delegated/gateway-context')) {
      const payload = Schema.decodeUnknownSync(GatewayDelegatedContextRequestSchema)(await sent.json());
      expect(payload.audience).toBe('party-registry');
      expect(payload.compositionRevision).toBe(snapshot.composition.revision);
      expect(payload.legalEntityScope).toBe('subject');
      const sourceMatches = Match.value(payload.subject).pipe(
        Match.tag('Assertion', ({ sourceAssertion }) => Redacted.value(sourceAssertion) === source),
        Match.orElse(() => false),
      );
      expect(sourceMatches).toBe(true);
      expect(sent.headers.get('x-api-key')).toBe('ccc-own-profile-test-module-key');
      issuanceCount += 1;
      const token = await new SignJWT({
        act: {
          appId: 'commerce-customer-context',
          buildMarker: ultramodernApiMarker.buildMarker,
          principalId: modulePrincipalId,
        },
        compositionRevision: snapshot.composition.revision,
        principal,
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: 3,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'own-profile-test', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('party-registry')
        .setSubject(storefrontPrincipalId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .setJti(`82000000-0000-4000-8000-${String(issuanceCount).padStart(12, '0')}`)
        .sign(pair.privateKey);
      return Response.json({
        apiBaseUrl: '/party-registry-api',
        compositionRevision: snapshot.composition.revision,
        expiresAt: issuedAt + 300,
        token,
      });
    }
    if (
      sent.url.endsWith('/reads/retail-customer-profile') ||
      sent.url.endsWith('/party-registry/actions/update-retail-customer-profile')
    ) {
      expect(sent.headers.get('x-ontos-composition-revision')).toBe(snapshot.composition.revision);
      expect(sent.headers.get('x-correlation-id')).not.toBeNull();
      const attestation = { ...input.session, sellingLegalEntityId: legalEntityId, tenantId };
      if (sent.url.endsWith('/reads/retail-customer-profile')) {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            attestation: Schema.Unknown,
            view: Schema.Literals(['IDENTITY', 'PROFILE']),
          }),
        )(await sent.json());
        expect(body.attestation).toEqual(attestation);
        if (body.view === 'IDENTITY') {
          return Response.json({
            _tag: 'RetailCustomerIdentity',
            partyRef: {
              moduleId: 'party.registry',
              resourceId: partyId,
              resourceType: 'party.registry.party',
              tenantId,
            },
          });
        }
      } else {
        expect(await sent.json()).toEqual({ attestation, update });
        expect(sent.headers.get('idempotency-key')).not.toBeNull();
        currentProfile = updatedProfile;
      }
      return Response.json({
        _tag: 'RetailCustomerProfile',
        partyRef: {
          moduleId: 'party.registry',
          resourceId: response.partyId ?? partyId,
          resourceType: 'party.registry.party',
          tenantId: response.tenantId ?? tenantId,
        },
        profile: currentProfile,
      });
    }
    // Generic Party detail/contact rights stay forbidden for the storefront workload. A
    // transport-only V3 change must not make this fixture invent sensitive-field authority.
    return Response.json(
      {
        _tag: 'PartyDetailForbiddenProblem',
        detail: 'The storefront workload has no generic Party profile authority',
        status: 403,
        title: 'Forbidden',
        type: 'https://ontos.dev/problems/party-profile-forbidden',
      },
      { status: 403 },
    );
  };
  // Keep the native receiving verifier in this test's Effect fiber: HTTP sends no nested root fiber.
  const verifyOwnerCalls = Effect.fn('OwnProfileDelegation.verifyOwnerCalls')(function* verifyOwnerCalls() {
    for (const sent of requests.filter(
      (request) =>
        request.url.endsWith('/reads/retail-customer-profile') ||
        request.url.endsWith('/party-registry/actions/update-retail-customer-profile'),
    )) {
      const verifiedReceiver = yield* bindGatewayPrincipalVerifier('party-registry', {
        appId: 'party-registry',
        buildMarker: ultramodernApiMarker.buildMarker,
      })
        .verifyAndRedeem(Redacted.make(sent.headers.get('authorization') ?? ''), {
          environment: verification,
          redemption: {
            consume: ({ jti }) =>
              Effect.sync(() => {
                expect(redeemed.has(jti)).toBe(false);
                redeemed.add(jti);
              }),
          },
        })
        .pipe(
          Effect.provideService(
            ActiveApplicationCompositionService,
            makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
          ),
        );
      expect(readVerifiedGatewayActor(verifiedReceiver)).toEqual({
        appId: 'commerce-customer-context',
        buildMarker: ultramodernApiMarker.buildMarker,
        principalId: modulePrincipalId,
      });
      expect(verifiedReceiver.principalId).toBe(storefrontPrincipalId);
      expect(verifiedReceiver.tenantId).toBe(tenantId);
      expect(verifiedReceiver.legalEntityId).toBe(legalEntityId);
    }
  });
  const configuration = Layer.mergeAll(
    CommerceAuthenticationNamespaceRegistryLive,
    Layer.succeed(
      ActiveApplicationCompositionService,
      makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
    ),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        COMMERCE_TENANT_CREDENTIALS: JSON.stringify({
          [tenantId]: {
            coreIdentityApiKey: 'legacy-core-key-must-not-be-used',
            gatewayApiKey: 'legacy-tenant-key-must-not-be-used',
          },
        }),
        ONTOS_SHELL_GATEWAY_BASE_URL: `${issuer}/shell-super-app-api`,
      }),
    ),
    Layer.effectDiscard(holdTestModuleCredentials({ 'commerce-customer-context': 'ccc-own-profile-test-module-key' })),
    Layer.succeed(FetchHttpClient.Fetch, fakeFetch),
  );
  const read = Effect.fn('OwnProfileDelegation.read')(function* read(admittedScope: typeof scope) {
    const harness = yield* makeReadTestHarness({
      access: 'allowed',
      compositionRevision: snapshot.composition.revision,
      databaseIdentities: enrollment,
      executeOwnerQuery: () => Effect.die('Own profile finish must not issue owner SQL'),
      onOwnerAuthorization: () => 'allowed',
      operationTime: yield* DateTime.nowAsDate,
      ownerRegistration: commerceCustomerContextRegistration,
      scope: admittedScope,
    });
    return yield* harness.runtime
      .runRead({
        input,
        principal: admittedScope,
        registration: customerOwnProfileRead,
        transport: { correlationId: admittedScope.correlationId },
      })
      .pipe(Effect.provide(configuration));
  });
  // This fixture isolates Core's admitted lifecycle and HTTP transport. Production session
  // owner-fact admission and Party SQL atomicity are covered by their own native suites.
  const auditEvents: CommercePortalAuthAuditEvent[] = [];
  const delivered: CustomerOwnProfile[] = [];
  const actionHarness = yield* makeActionTestHarness({
    access: 'allowed',
    applicationComposition: makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
    compositionRevision: snapshot.composition.revision,
    databaseIdentities: enrollment,
    expectedDeployment: ultramodernApiMarker,
    onOwnerAuthorization: () => 'allowed',
    ownerRegistration: commerceCustomerContextRegistration,
    services: [bindActionTestServices(updateOwnCustomerProfileAction, {})],
  });
  const write = (idempotencyKey = 'own-profile-native-update') =>
    actionHarness.runtime
      .runAction({
        payload: Schema.decodeUnknownSync(UpdateOwnCustomerProfilePayloadSchema)({ session: input.session, update }),
        principal: scope,
        registration: updateOwnCustomerProfileAction,
        transport: { correlationId: scope.correlationId, idempotencyKey },
      })
      .pipe(
        Effect.provideService(CustomerOwnProfileUpdateExchange, {
          deliver: (value) =>
            Effect.sync(() => {
              delivered.push(value);
            }),
          sessionRef: 'admitted-customer-session',
        }),
        Effect.provideService(CommercePortalAuthAudit, {
          record: (event) =>
            Effect.sync(() => {
              auditEvents.push(event);
            }),
        }),
        Effect.provide(configuration),
      );
  const readIdentity = ownPortalScope(
    {
      compositionRevision: snapshot.composition.revision,
      scope,
      session: input.session,
    },
    profileUnavailable,
  ).pipe(Effect.flatMap(readDirectCustomerParty), Effect.provide(configuration));
  return { auditEvents, delivered, read, readIdentity, redeemed, requests, scope, verifyOwnerCalls, write };
});

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'reads the admitted customer own profile without losing verified module delegation or widening generic Party rights',
    () =>
      Effect.gen(function* fullOwnProfileRead() {
        const fixture = yield* makeFixture();
        const result = yield* fixture.read(fixture.scope).pipe(Effect.result);
        const failure = Result.isFailure(result) ? result.failure : 'none';
        expect(
          Result.isSuccess(result),
          JSON.stringify({ failure, paths: fixture.requests.map((sent) => new URL(sent.url).pathname) }),
        ).toBe(true);
        expect(yield* Effect.fromResult(result)).toEqual(profile);
        yield* fixture.verifyOwnerCalls();
        expect(fixture.requests.map((sent) => new URL(sent.url).pathname)).toEqual([
          '/shell-super-app-api/auth/delegated/gateway-context',
          '/party-registry-api/reads/retail-customer-profile',
        ]);
        expect(fixture.redeemed.size).toBe(1);
      }),
  );
  suite.effect('checks consent Party identity without asking for profile contacts or personal fields', () =>
    Effect.gen(function* ownConsentIdentity() {
      const fixture = yield* makeFixture();
      expect(yield* fixture.readIdentity).toEqual({
        partyRef: { moduleId: 'party.registry', resourceId: partyId, resourceType: 'party.registry.party', tenantId },
      });
      yield* fixture.verifyOwnerCalls();
      expect(fixture.requests.map((sent) => new URL(sent.url).pathname)).toEqual([
        '/shell-super-app-api/auth/delegated/gateway-context',
        '/party-registry-api/reads/retail-customer-profile',
      ]);
      expect(fixture.redeemed.size).toBe(1);
    }),
  );
  suite.effect('delegates the admitted own-profile update through one finite Party Action and does not replay it', () =>
    Effect.gen(function* nativeOwnProfileUpdate() {
      const fixture = yield* makeFixture();
      const result = yield* fixture.write();
      yield* fixture.verifyOwnerCalls();
      expect(result).toMatchObject({ authorized: true });
      expect(fixture.delivered).toEqual([updatedProfile]);
      expect(
        fixture.requests.filter((sent) => sent.url.endsWith('/party-registry/actions/update-retail-customer-profile')),
      ).toHaveLength(1);
      expect(fixture.requests.every((sent) => !sent.url.endsWith('/auth/api-key/gateway-context'))).toBe(true);
      const ownerCalls = fixture.requests.filter((sent) => !sent.url.endsWith('/gateway-context'));
      expect(
        ownerCalls.every(
          (sent) =>
            sent.url.endsWith('/reads/retail-customer-profile') ||
            sent.url.endsWith('/party-registry/actions/update-retail-customer-profile'),
        ),
      ).toBe(true);
      expect(fixture.redeemed.size).toBe(ownerCalls.length);
      expect(fixture.auditEvents.map(({ eventType }) => eventType)).toEqual([
        'commerce.portal-auth.profile-update-requested.v1',
        'commerce.portal-auth.profile-updated.v1',
      ]);
      const callsBeforeReplay = fixture.requests.length;
      const replay = yield* fixture.write().pipe(Effect.result);
      expect(Result.isFailure(replay)).toBe(true);
      expect(fixture.requests).toHaveLength(callsBeforeReplay);
      expect(fixture.delivered).toHaveLength(1);
    }),
  );
  for (const response of [
    { partyId: '41000000-0000-4000-8000-000000000001' },
    { tenantId: '11000000-0000-4000-8000-000000000001' },
  ]) {
    suite.effect(`rejects a bounded owner response for a different ${'partyId' in response ? 'Party' : 'tenant'}`, () =>
      Effect.gen(function* crossedOwnerResponse() {
        const fixture = yield* makeFixture(response);
        const failure = yield* fixture.read(fixture.scope).pipe(Effect.flip);
        yield* fixture.verifyOwnerCalls();
        expect(failure).toMatchObject({ code: 'profile_unavailable', status: 503 });
        expect(fixture.redeemed.size).toBe(1);
      }),
    );
  }
  suite.effect('refuses missing source provenance before any own profile owner request', () =>
    Effect.gen(function* missingSource() {
      const fixture = yield* makeFixture();
      const result = yield* fixture.read({ ...principal, correlationId: 'missing-source' }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(fixture.requests).toEqual([]);
    }),
  );
  suite.effect('refuses a copied and forged source identity before any own profile owner request', () =>
    Effect.gen(function* forgedSource() {
      const fixture = yield* makeFixture();
      const copiedPrincipal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        ...fixture.scope,
        principalId: '90000000-0000-4000-8000-000000000001',
      });
      const forged = { ...copiedPrincipal, correlationId: 'forged-source' };
      const result = yield* fixture.read(forged).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(fixture.requests).toEqual([]);
    }),
  );
});
