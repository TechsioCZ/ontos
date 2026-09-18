import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Clock, ConfigProvider, Context, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { GatewayAssertionRedemptionService } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { makeGatewayPrincipalVerifierLayer } from '@app/gateway-principal-verifier/server';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import {
  CommercePortalAuthVerificationInvalidRequest,
  CommercePortalAuthVerificationService,
} from '../../api/portal-auth/provider/verification.ts';
import {
  commercePortalAuthVerificationApiLive,
  CommercePortalAuthVerificationWorkloadAuthorization,
  CommercePortalAuthVerificationWorkloadRejected,
  CommercePortalAuthVerificationWorkloadUnavailable,
} from '../../api/portal-auth/verification-http/server.ts';
import {
  CommercePortalAuthVerificationApi,
  CommercePortalAuthVerificationRequestSchema,
} from '../../shared/portal-auth-verification.ts';
import type {
  CommercePortalAuthVerificationWorkloadAuthorizationInput,
  CommercePortalAuthVerificationWorkloadAuthorizationService,
} from '../../api/portal-auth/verification-http/server.ts';
import {
  CommercePortalAuthVerificationClientUnavailable,
  makeCommercePortalAuthVerificationClient,
} from '../../src/api/portal-auth-verification/client.ts';
import { CommercePortalAuthVerificationClientConfigurationService } from '../../src/api/portal-auth-verification/client-configuration.ts';
import type { CommercePortalAuthVerificationWorkloadAssertionService } from '../../src/api/portal-auth-verification/workload-assertion.ts';
import { CommercePortalAuthVerificationWorkloadAssertion } from '../../src/api/portal-auth-verification/workload-assertion.ts';
import { commercePortalAuthVerificationWorkloadAuthorizationLive } from '../../api/portal-auth/verification-http/workload-authorization.ts';
import {
  CommercePortalAuthVerificationWorkloadGrantConfiguration,
  CommercePortalAuthVerificationWorkloadGrantsSchema,
} from '../../api/portal-auth/verification-http/workload-grants.ts';
import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  VerifyExternalAuthenticationRequestSchema,
  VerifyExternalAuthenticationResultSchema,
} from '../../shared/portal-auth-contracts.ts';

const now = DateTime.makeUnsafe('2026-09-17T09:00:00.000Z');
const request = Schema.decodeUnknownSync(CommercePortalAuthVerificationRequestSchema)({
  audience: 'commerce-customer-context',
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  nonce: '50000000-0000-4000-8000-000000000011',
  operation: 'commerce-portal-authentication.verify-external-authentication.v1',
  operationRef: 'integration-operation-1',
  providerSubjectId: 'provider-subject-01',
  sessionRef: 'better-auth-session:ontos.commerce.portal.better-auth.v1:session-01',
  subjectType: 'user',
  tenantId: '10000000-0000-4000-8000-000000000002',
});
const requestContext = Context.makeUnsafe<unknown>(new Map());
const signedWorkloadEpochMillis = DateTime.toEpochMillis(now);
const signedWorkloadClock: Clock.Clock = {
  currentTimeMillis: Effect.succeed(signedWorkloadEpochMillis),
  currentTimeMillisUnsafe: () => signedWorkloadEpochMillis,
  currentTimeNanos: Effect.succeed(BigInt(signedWorkloadEpochMillis) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(signedWorkloadEpochMillis) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(signedWorkloadEpochMillis) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(signedWorkloadEpochMillis) * 1_000_000n,
  sleep: () => Effect.never,
};

const verification = {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The provider service deliberately decodes its private request boundary.
  verifyExternalAuthentication: (input: unknown) =>
    Schema.decodeUnknownEffect(VerifyExternalAuthenticationRequestSchema)(input).pipe(
      Effect.map((decoded) =>
        Schema.decodeUnknownSync(VerifyExternalAuthenticationResultSchema)({
          authenticatedAt: now,
          authenticationNamespaceId: decoded.authenticationNamespaceId,
          emailVerified: true,
          nonce: decoded.nonce,
          observedAt: now,
          outcome: 'ALLOWED',
          providerSubjectId: decoded.providerSubjectId,
          sessionRef: decoded.sessionRef,
          subjectType: decoded.subjectType,
          tenantId: decoded.tenantId,
        }),
      ),
      Effect.mapError(() => new CommercePortalAuthVerificationInvalidRequest({ reason: 'invalid provider request' })),
    ),
};

const AuthorityModeSchema = Schema.Literals(['allow', 'reject', 'unavailable']);
type AuthorityMode = typeof AuthorityModeSchema.Type;

const makeApp = (
  mode: { value: AuthorityMode },
  captures: CommercePortalAuthVerificationWorkloadAuthorizationInput[],
) =>
  Effect.gen(function* makeAppEffect() {
    const authority: CommercePortalAuthVerificationWorkloadAuthorizationService = {
      authorize: (input) => {
        captures.push(input);
        if (mode.value === 'reject') {
          return Effect.fail(
            CommercePortalAuthVerificationWorkloadRejected.make({ reason: 'workload is not trusted' }),
          );
        }
        if (mode.value === 'unavailable') {
          return Effect.fail(
            CommercePortalAuthVerificationWorkloadUnavailable.make({ reason: 'authority is unavailable' }),
          );
        }
        return Effect.void;
      },
    };
    const apiLayer = HttpApiBuilder.layer(CommercePortalAuthVerificationApi).pipe(
      Layer.provide(commercePortalAuthVerificationApiLive),
      Layer.provide(Layer.succeed(CommercePortalAuthVerificationWorkloadAuthorization, authority)),
      Layer.provide(Layer.succeed(CommercePortalAuthVerificationService, verification)),
      Layer.provide(HttpServer.layerServices),
    );
    return yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(apiLayer, { disableLogger: true })),
      (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
    );
  });

const workloadIssuer = 'https://shell.ontos.test';
const workloadProviderEndpointAudience = 'commerce-portal-auth-verification';
const workloadAuthenticationNamespaceId = 'ontos.staff.gateway-api-key.v1';
const workloadPrincipalId = '10000000-0000-4000-8000-000000000010';
const workloadAuthBindingId = '10000000-0000-4000-8000-000000000011';
const workloadAuthContextRef = 'gateway-api-key:commerce-workload-test';

const makeSignedWorkloadFixture = () =>
  Effect.gen(function* makeSignedWorkloadFixtureEffect() {
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'commerce-workload-test',
      use: 'sig',
    };
    const issuedAt = Math.floor(signedWorkloadEpochMillis / 1000) - 30;
    const token = yield* Effect.promise(() =>
      new SignJWT({
        principal: {
          authBindingId: workloadAuthBindingId,
          authContextRef: workloadAuthContextRef,
          authenticationNamespaceId: workloadAuthenticationNamespaceId,
          authMethod: 'api_key',
          principalId: workloadPrincipalId,
          tenantId: request.tenantId,
        },
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'commerce-workload-test', typ: 'JWT' })
        .setIssuer(workloadIssuer)
        .setAudience(workloadProviderEndpointAudience)
        .setSubject(workloadPrincipalId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .setJti('10000000-0000-4000-8000-000000000013')
        .sign(privateKey),
    );
    const environment = {
      ONTOS_GATEWAY_ISSUER: workloadIssuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        keys: [publicJwk],
      }),
    };
    return { environment, token };
  });

const makeSignedWorkloadAuthority = (environment: {
  readonly ONTOS_GATEWAY_ISSUER: string;
  readonly ONTOS_GATEWAY_PUBLIC_JWKS: string;
}) => {
  const grantConfiguration = Schema.decodeUnknownSync(CommercePortalAuthVerificationWorkloadGrantsSchema)({
    grants: [
      {
        commerceAuthenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        operation: request.operation,
        receivingAudience: request.audience,
        tenantId: request.tenantId,
        workloadAuthenticationNamespaceId,
        workloadPrincipalId,
      },
    ],
    providerEndpointAudience: workloadProviderEndpointAudience,
  });
  return Layer.mergeAll(
    commercePortalAuthVerificationWorkloadAuthorizationLive,
    Layer.succeed(CommercePortalAuthVerificationWorkloadGrantConfiguration, grantConfiguration),
    Layer.succeed(GatewayAssertionRedemptionService, { consume: () => Effect.void }),
    makeGatewayPrincipalVerifierLayer(ConfigProvider.fromUnknown(environment)),
  );
};

const makeSignedWorkloadApp = (environment: {
  readonly ONTOS_GATEWAY_ISSUER: string;
  readonly ONTOS_GATEWAY_PUBLIC_JWKS: string;
}) =>
  Effect.gen(function* makeSignedWorkloadAppEffect() {
    const authority = makeSignedWorkloadAuthority(environment);
    const apiLayer = HttpApiBuilder.layer(CommercePortalAuthVerificationApi).pipe(
      Layer.provide(commercePortalAuthVerificationApiLive),
      Layer.provideMerge(authority),
      Layer.provideMerge(Layer.succeed(Clock.Clock, signedWorkloadClock)),
      Layer.provide(Layer.succeed(CommercePortalAuthVerificationService, verification)),
      Layer.provide(HttpServer.layerServices),
    );
    return yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(apiLayer, { disableLogger: true })),
      (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
    );
  });

const makeClient = (baseUrl: string, workloadAssertions: CommercePortalAuthVerificationWorkloadAssertionService) =>
  makeCommercePortalAuthVerificationClient().pipe(
    Effect.provideService(CommercePortalAuthVerificationClientConfigurationService, { baseUrl }),
    Effect.provideService(CommercePortalAuthVerificationWorkloadAssertion, workloadAssertions),
  );

it.effect('requires workload authority and acquires a fresh assertion for every HTTP call', () =>
  Effect.gen(function* trustedWorkloadBoundary() {
    const mode = { value: Schema.decodeUnknownSync(AuthorityModeSchema)('allow') };
    const captures: CommercePortalAuthVerificationWorkloadAuthorizationInput[] = [];
    const app = yield* makeApp(mode, captures);
    const missingAuthorization = yield* Effect.promise(() =>
      app.handler(
        new Request('https://commerce.ontos.test/portal-auth/internal/verify', {
          body: JSON.stringify(request),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        requestContext,
      ),
    );
    expect(missingAuthorization.status).toBe(401);

    const issuedAssertions: string[] = [];
    const workloadAssertions: CommercePortalAuthVerificationWorkloadAssertionService = {
      acquire: () => {
        const value = `workload-secret-${issuedAssertions.length + 1}`;
        issuedAssertions.push(value);
        return Effect.succeed(Redacted.make(value));
      },
    };
    const fakeFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), requestContext);
    const client = yield* makeClient('https://commerce.ontos.test', workloadAssertions);
    const first = yield* client
      .verify(request, { requestCorrelation: 'integration-correlation-1' })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    const second = yield* client
      .verify(request, { requestCorrelation: 'integration-correlation-2' })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

    expect(first.outcome).toBe('ALLOWED');
    expect(second.outcome).toBe('ALLOWED');
    expect(issuedAssertions).toEqual(['workload-secret-1', 'workload-secret-2']);
    expect(captures).toHaveLength(2);
    const [firstCapture, secondCapture] = captures;
    expect(firstCapture).toBeDefined();
    expect(secondCapture).toBeDefined();
    if (firstCapture !== undefined && secondCapture !== undefined) {
      expect(Redacted.value(firstCapture.authorization)).toBe('workload-secret-1');
      expect(Redacted.value(secondCapture.authorization)).toBe('workload-secret-2');
      expect(firstCapture.requestCorrelation).toBe('integration-correlation-1');
      expect(secondCapture.requestCorrelation).toBe('integration-correlation-2');
      expect(firstCapture.request).toMatchObject(request);
    }
  }),
);

it.effect('maps owner rejection, outage, and malformed payloads to fail-closed HTTP responses', () =>
  Effect.gen(function* failClosedResponses() {
    const mode = { value: Schema.decodeUnknownSync(AuthorityModeSchema)('reject') };
    const captures: CommercePortalAuthVerificationWorkloadAuthorizationInput[] = [];
    const app = yield* makeApp(mode, captures);
    const workloadAssertions: CommercePortalAuthVerificationWorkloadAssertionService = {
      acquire: () => Effect.succeed(Redacted.make('workload-secret')),
    };
    const fakeFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), requestContext);
    const client = yield* makeClient('https://commerce.ontos.test', workloadAssertions);

    const rejected = yield* client
      .verify(request, { requestCorrelation: 'integration-correlation-3' })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.flip);
    expect(rejected).toBeInstanceOf(CommercePortalAuthVerificationClientUnavailable);

    const rejectedResponse = yield* Effect.promise(() =>
      app.handler(
        new Request('https://commerce.ontos.test/portal-auth/internal/verify', {
          body: JSON.stringify(request),
          headers: { authorization: 'Bearer workload-secret', 'content-type': 'application/json' },
          method: 'POST',
        }),
        requestContext,
      ),
    );
    expect(rejectedResponse.status).toBe(403);

    mode.value = 'unavailable';
    const unavailableResponse = yield* Effect.promise(() =>
      app.handler(
        new Request('https://commerce.ontos.test/portal-auth/internal/verify', {
          body: JSON.stringify(request),
          headers: { authorization: 'Bearer workload-secret', 'content-type': 'application/json' },
          method: 'POST',
        }),
        requestContext,
      ),
    );
    expect(unavailableResponse.status).toBe(503);

    mode.value = 'allow';
    const malformedResponse = yield* Effect.promise(() =>
      app.handler(
        new Request('https://commerce.ontos.test/portal-auth/internal/verify', {
          body: JSON.stringify({ ...request, nonce: 'malformed-nonce' }),
          headers: { authorization: 'Bearer workload-secret', 'content-type': 'application/json' },
          method: 'POST',
        }),
        requestContext,
      ),
    );
    expect(malformedResponse.status).toBe(400);
    expect(captures).toHaveLength(3);
  }),
);

it.effect('accepts a signed workload assertion through the real authority and HTTP boundary', () =>
  Effect.gen(function* signedWorkloadBoundary() {
    const fixture = yield* makeSignedWorkloadFixture();
    const app = yield* makeSignedWorkloadApp(fixture.environment);
    const workloadAssertions: CommercePortalAuthVerificationWorkloadAssertionService = {
      acquire: () => Effect.succeed(Redacted.make(`Bearer ${fixture.token}`)),
    };
    const fakeFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), requestContext);
    const client = yield* makeClient('https://commerce.ontos.test', workloadAssertions);
    const result = yield* client
      .verify(request, { requestCorrelation: 'integration-correlation-signed-workload' })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

    expect(result.outcome).toBe('ALLOWED');
  }),
);
