import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { ActiveApplicationCompositionService, ReadRuntime } from '@app/core-runtime';
import type { ReadRuntimeService } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeGatewayPrincipalVerifierLayer } from '@app/gateway-principal-verifier/server';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { Clock, ConfigProvider, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthConfigValue } from '../../api/portal-auth/provider/config.ts';
import {
  CommerceCustomerAuthority,
  CustomerAuthorityRejected,
} from '../../api/portal-auth/session/customer-authority.ts';
import type { CustomerAuthorityInput } from '../../api/portal-auth/session/customer-authority.ts';
import { CommercePortalAuthSessionEvidenceRejected } from '../../api/portal-auth/session/errors.ts';
import { CommercePortalAuthService, portalAuthSessionApiLive } from '../../api/portal-auth/session/http.ts';
import { CommercePortalAuthSessionLifecycle } from '../../api/portal-auth/session/lifecycle.ts';
import type { CommercePortalAuthSessionLifecycleService } from '../../api/portal-auth/session/lifecycle.ts';
import { CommercePortalAuthProviderSubjectIdSchema } from '../../api/portal-auth/session/contracts.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  CommerceSessionReferenceSchema,
} from '../../shared/portal-auth-contracts.ts';
import { EnrollmentResourceIdSchema } from '../../shared/enrollment-contracts.ts';
import { CommercePortalAuthSessionApi } from '../../shared/portal-auth/session-api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { CommercePortalAuthAudit, unauditedCommercePortalAuthRecorder } from '../../src/portal-auth/audit/audit.ts';
import { jsonBody } from '../support/response.ts';

const origin = 'https://address-book.portal.test';
const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const customerPrincipalId = '00000000-0000-4000-8000-000000000003';
const customerBindingId = '00000000-0000-4000-8000-000000000004';
const profileId = '00000000-0000-4000-8000-000000000005';
const partyId = Schema.decodeUnknownSync(EnrollmentResourceIdSchema)('00000000-0000-4000-8000-000000000006');
const workloadPrincipalId = '00000000-0000-4000-8000-000000000007';
const workloadBindingId = '00000000-0000-4000-8000-000000000008';
const profile = {
  kind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
} as const;
const addressRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'own-address',
  resourceType: 'commerce.customer-context.saved-address',
  tenantId,
} as const;
const address = {
  label: 'Doručení',
  lifecycle: 'ACTIVE',
  origin: {
    kind: 'COMMERCE_ONLY',
    postalAddress: {
      addressLine1: 'Ulice 1',
      addressLine2: 'Patro 2',
      city: 'Praha',
      countryCode: 'CZ',
      postalCode: '11000',
      region: 'Praha',
    },
  },
  profile,
  purposes: ['DELIVERY'],
  revision: 1,
  savedAddressRef: addressRef,
};
const defaults = { delivery: addressRef, profile, revision: 1 };
const configuration: CommercePortalAuthConfigValue = {
  baseUrl: origin,
  connectionString: Redacted.make('postgres://unused.invalid/unused'),
  nodeEnvironment: 'test',
  policy: COMMERCE_PORTAL_AUTH_POLICY,
  secret: Redacted.make('s'.repeat(64)),
  secureCookies: true,
  trustedOrigins: [origin],
  trustedProxies: [],
  versionedSecrets: [],
};
const FixtureModeSchema = Schema.Literals(['admitted', 'no-session', 'unverified', 'denied']);
type Mode = typeof FixtureModeSchema.Type;
const epochMillis = Date.parse('2026-01-01T00:00:00Z');
const gatewayClock: Clock.Clock = {
  currentTimeMillis: Effect.succeed(epochMillis),
  currentTimeMillisUnsafe: () => epochMillis,
  currentTimeNanos: Effect.succeed(BigInt(epochMillis) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(epochMillis) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(epochMillis) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(epochMillis) * 1_000_000n,
  sleep: () => Effect.never,
};

const makeFixture = (mode: Mode) =>
  Effect.gen(function* addressBookTransportFixture() {
    // The real provider stays entirely in memory and never has an e-mail dispatcher.
    const realm = betterAuth({
      baseURL: origin,
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      emailAndPassword: { enabled: true },
      secret: 'offline-only-realm-secret'.repeat(3),
      session: { updateAge: 0 },
      trustedOrigins: [origin],
    });
    const signedUp = yield* Effect.promise(() =>
      realm.api.signUpEmail({
        body: { email: 'owner@example.test', name: 'Address Owner', password: 'offline-password'.repeat(2) },
        headers: new Headers({ origin }),
        returnHeaders: true,
      }),
    );
    const providerSubjectId = Schema.decodeUnknownSync(CommercePortalAuthProviderSubjectIdSchema)(
      signedUp.response.user.id,
    );
    const cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(cookie.length).toBeGreaterThan(0);
    let evidenceCalls = 0;
    const authorityCalls: CustomerAuthorityInput[] = [];
    const reads: {
      readonly input: unknown;
      readonly principal: unknown;
      readonly readKey: string;
      readonly transport: Parameters<ReadRuntimeService['runRead']>[0]['transport'];
    }[] = [];
    const lifecycle: CommercePortalAuthSessionLifecycleService = {
      disableAccount: () => Effect.die('GET must not disable an account'),
      evidenceForSession: (input) => {
        evidenceCalls += 1;
        expect(input.expectedProviderSubjectId).toBe(providerSubjectId);
        if (mode === 'unverified') {
          return Effect.fail(
            new CommercePortalAuthSessionEvidenceRejected({
              reason: 'Commerce portal session is expired or unverified',
            }),
          );
        }
        return Effect.succeed({
          assurance: 'password' as const,
          authenticatedAt: new Date('2026-01-01T00:00:00Z'),
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          observedAt: new Date('2026-01-01T00:00:01Z'),
          policyVersion: COMMERCE_PORTAL_AUTH_POLICY.policyVersion,
          providerSubjectId,
          sessionRef: Schema.decodeUnknownSync(CommerceSessionReferenceSchema)(input.sessionRef),
          subjectType: 'user' as const,
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        });
      },
      refresh: () => Effect.die('GET must not refresh'),
      revoke: () => Effect.die('GET must not revoke'),
      revokeAll: () => Effect.die('GET must not revoke sessions'),
      revokeUnaudited: () => Effect.die('GET must not revoke sessions'),
      rotateIdentifierForCookie: () => Effect.die('GET must not rotate'),
      signIn: () => Effect.die('GET must not sign in'),
      signOut: () => Effect.die('GET must not sign out'),
    };
    const runtime: ReadRuntimeService = {
      runRead: (input) => {
        reads.push({
          input: input.input,
          principal: input.principal,
          readKey: input.registration.descriptor.readKey,
          transport: input.transport,
        });
        const result = input.registration.descriptor.readKey.endsWith('saved-address-list')
          ? { addresses: [address] }
          : { defaults };
        return Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(result).pipe(Effect.orDie);
      },
    };

    // Real signed gateway verification, with only ephemeral test keys and explicit in-memory configuration.
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(
      [ultramodernApiMarker.appId],
      ultramodernApiMarker.buildMarker,
    ).pipe(Effect.provideService(Clock.Clock, gatewayClock));
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'address-book-test',
      use: 'sig',
    };
    const issuer = 'https://gateway.address-book.test';
    const now = Math.floor(epochMillis / 1000);
    const assertion = yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: snapshot.composition.revision,
        principal: {
          authBindingId: workloadBindingId,
          authContextRef: 'gateway-api-key:address-book',
          authenticationNamespaceId: 'ontos.staff.gateway-api-key.v1',
          authMethod: 'api_key',
          legalEntityId,
          principalId: workloadPrincipalId,
          tenantId,
        },
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'address-book-test', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('commerce-customer-context')
        .setSubject(workloadPrincipalId)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .setJti('00000000-0000-4000-8000-000000000009')
        .sign(privateKey),
    );
    const authority: CommerceCustomerAuthority['Service'] = {
      admit: (input) => {
        authorityCalls.push(input);
        return mode === 'denied'
          ? Effect.fail(new CustomerAuthorityRejected())
          : Effect.succeed({ authBindingId: customerBindingId, partyId, principalId: customerPrincipalId, profileId });
      },
    };
    const services = Layer.mergeAll(
      Layer.succeed(CommercePortalAuthService, { api: realm.api }),
      Layer.succeed(CommercePortalAuthSessionLifecycle, lifecycle),
      Layer.succeed(CommerceCustomerAuthority, authority),
      Layer.succeed(ReadRuntime, runtime),
      Layer.succeed(CommercePortalAuthConfig, configuration),
      Layer.succeed(CommercePortalAuthAudit, unauditedCommercePortalAuthRecorder),
      Layer.succeed(CommercePortalAuthRecoveryRateLimitService, {
        consume: () => Effect.die('GET must not spend a budget'),
      }),
      Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
      Layer.succeed(GatewayAssertionRedemptionService, { consume: () => Effect.void }),
      makeGatewayPrincipalVerifierLayer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
        }),
      ),
      commercePortalAuthPlatformCryptoLive,
      HttpServer.layerServices,
      Layer.succeed(Clock.Clock, gatewayClock),
    );
    const handlerContext = yield* Layer.build(services);
    const api = HttpApi.make('CommerceCustomerContextApi').addHttpApi(CommercePortalAuthSessionApi);
    const layer = HttpApiBuilder.layer(api).pipe(
      Layer.provide(portalAuthSessionApiLive),
      Layer.provide(Layer.succeedContext(handlerContext)),
    );
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
      (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
    );
    const response = yield* Effect.promise(() =>
      app.handler(
        new Request(`${origin}/api/portal-auth/customer-address-book`, {
          headers: { authorization: `Bearer ${assertion}`, cookie: mode === 'no-session' ? '' : cookie },
          method: 'GET',
        }),
        handlerContext,
      ),
    );
    return { authorityCalls, evidenceCalls, providerSubjectId, reads, response };
  });

it.effect('composed address-book GET uses the admitted customer principal and exact generated owner reads', () =>
  Effect.scoped(
    Effect.gen(function* composedOwnAddressBook() {
      const f = yield* makeFixture('admitted');
      expect(f.response.status).toBe(200);
      expect(yield* jsonBody(f.response)).toEqual({ addresses: [address], defaults });
      expect(f.response.headers.get('cache-control')).toBe('no-store');
      expect(f.response.headers.getSetCookie()).toEqual([]);
      expect(f.evidenceCalls).toBe(1);
      expect(f.authorityCalls).toHaveLength(1);
      expect(f.authorityCalls[0]).toMatchObject({
        legalEntityId,
        permission: 'retail.address_book.use',
        providerSubjectId: f.providerSubjectId,
        tenantId,
      });
      expect(f.reads.map((read) => read.readKey)).toEqual([
        'commerce.customer-context.api.saved-address-list',
        'commerce.customer-context.api.saved-address-defaults',
      ]);
      for (const read of f.reads) {
        expect(read.input).toEqual({ profile });
        expect(read.principal).toMatchObject({
          authBindingId: customerBindingId,
          authContextRef: f.authorityCalls[0]?.sessionRef,
          authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
          authMethod: 'session',
          legalEntityId,
          principalId: customerPrincipalId,
          tenantId,
        });
        expect(read.principal).not.toMatchObject({ principalId: workloadPrincipalId });
        expect(read.transport).toEqual({ correlationId: expect.stringMatching(/^[a-f\d-]{36}$/u) });
      }
      expect(f.reads[0]?.transport).toEqual(f.reads[1]?.transport);
    }),
  ),
);

for (const [mode, status, code] of [
  ['no-session', 401, 'authentication_failed'],
  ['unverified', 401, 'session_expired'],
  ['denied', 403, 'account_disabled'],
] as const) {
  it.effect(`composed address-book ${mode} refuses before every owner Read`, () =>
    Effect.scoped(
      Effect.gen(function* refusedOwnAddressBook() {
        const f = yield* makeFixture(mode);
        expect(f.response.status).toBe(status);
        expect(yield* jsonBody(f.response)).toMatchObject({ code, status });
        expect(f.reads).toEqual([]);
        expect(f.evidenceCalls).toBe(mode === 'no-session' ? 0 : 1);
        expect(f.authorityCalls).toHaveLength(mode === 'denied' ? 1 : 0);
        expect(f.response.headers.get('cache-control')).toBe('no-store');
        expect(f.response.headers.getSetCookie()).toEqual([]);
      }),
    ),
  );
}
