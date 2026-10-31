import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import {
  Clock,
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient, HttpServerRequest } from 'effect/http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import type { GatewayAssertionRedemption } from '@app/core-runtime/auth/gateway-assertion-redemption';
import { ActiveApplicationCompositionService, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { makeGatewayPrincipalVerifierLayer } from '@app/gateway-principal-verifier/server';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  CommercePortalAuthVerificationInvalidRequest,
  CommercePortalAuthVerificationService,
} from '../../api/portal-auth/provider/verification.ts';
import {
  commercePortalAuthVerificationApiLive,
  CommercePortalAuthVerificationHttpExecutor,
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
import { CommercePortalAuthSessionReaderService } from '../../api/portal-auth/provider/session-reader-service.ts';
import {
  CommerceEnrollmentProofService,
  CommerceEnrollmentProofRejected,
} from '../../api/portal-auth/enrollment-proof-port.ts';
import type { CommercePortalAuthVerificationInput } from '../../api/portal-auth/provider/verification.ts';
import apiRuntime, {
  commercePortalAuthVerificationProviderLive,
  commercePortalAuthVerificationHttpExecutorLive,
} from '../../api/index.ts';
import { commerceCustomerContextApi } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const now = DateTime.makeUnsafe('2026-09-17T09:00:00.000Z');
const request = Schema.decodeUnknownSync(CommercePortalAuthVerificationRequestSchema)({
  audience: 'commerce-customer-context',
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  authenticationOperation: 'resolve',
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
          authenticationOperation: 'resolve',
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
  provider: CommercePortalAuthVerificationService['Service'] = verification,
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
        return Effect.succeed(
          Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
            authBindingId: '10000000-0000-4000-8000-000000000011',
            authContextRef: 'gateway-api-key:transport-double',
            authenticationNamespaceId: 'ontos.staff.gateway-api-key.v1',
            authMethod: 'api_key',
            principalId: '10000000-0000-4000-8000-000000000010',
            tenantId: request.tenantId,
          }),
        );
      },
    };
    const apiLayer = HttpApiBuilder.layer(CommercePortalAuthVerificationApi).pipe(
      Layer.provide(commercePortalAuthVerificationApiLive),
      Layer.provide(commercePortalAuthVerificationHttpExecutorLive),
      Layer.provide(Layer.succeed(CommercePortalAuthVerificationWorkloadAuthorization, authority)),
      Layer.provide(Layer.succeed(CommercePortalAuthVerificationService, provider)),
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
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(
      [ultramodernApiMarker.appId],
      ultramodernApiMarker.buildMarker,
    ).pipe(Effect.provideService(Clock.Clock, signedWorkloadClock));
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'commerce-workload-test',
      use: 'sig',
    };
    const issuedAt = Math.floor(signedWorkloadEpochMillis / 1000) - 30;
    const tokenFor = (jti: string) =>
      Effect.promise(() =>
        new SignJWT({
          compositionRevision: snapshot.composition.revision,
          principal: {
            authBindingId: workloadAuthBindingId,
            authContextRef: workloadAuthContextRef,
            authenticationNamespaceId: workloadAuthenticationNamespaceId,
            authMethod: 'api_key',
            principalId: workloadPrincipalId,
            tenantId: request.tenantId,
          },
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: 'commerce-workload-test', typ: 'JWT' })
          .setIssuer(workloadIssuer)
          .setAudience(workloadProviderEndpointAudience)
          .setSubject(workloadPrincipalId)
          .setIssuedAt(issuedAt)
          .setExpirationTime(issuedAt + 300)
          .setJti(jti)
          .sign(privateKey),
      );
    const environment = {
      ONTOS_GATEWAY_ISSUER: workloadIssuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        keys: [publicJwk],
      }),
    };
    const token = yield* tokenFor('10000000-0000-4000-8000-000000000013');
    return { environment, snapshot, token, tokenFor };
  });

const makeSignedWorkloadAuthority = (
  environment: {
    readonly ONTOS_GATEWAY_ISSUER: string;
    readonly ONTOS_GATEWAY_PUBLIC_JWKS: string;
  },
  snapshot: ActiveApplicationCompositionSnapshot,
  redemption?: GatewayAssertionRedemption,
) => {
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
    Layer.succeed(GatewayAssertionRedemptionService, redemption ?? { consume: () => Effect.void }),
    Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
    makeGatewayPrincipalVerifierLayer(ConfigProvider.fromUnknown(environment)),
  );
};

const makeSignedWorkloadApp = (
  environment: {
    readonly ONTOS_GATEWAY_ISSUER: string;
    readonly ONTOS_GATEWAY_PUBLIC_JWKS: string;
  },
  snapshot: ActiveApplicationCompositionSnapshot,
) =>
  Effect.gen(function* makeSignedWorkloadAppEffect() {
    const authority = makeSignedWorkloadAuthority(environment, snapshot);
    const apiLayer = HttpApiBuilder.layer(CommercePortalAuthVerificationApi).pipe(
      Layer.provide(commercePortalAuthVerificationApiLive),
      Layer.provide(commercePortalAuthVerificationHttpExecutorLive),
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
    const app = yield* makeSignedWorkloadApp(fixture.environment, fixture.snapshot);
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

const canonicalRequest = Schema.decodeUnknownSync(VerifyExternalAuthenticationRequestSchema)(request);
const incrementBridgeCounter = (value: number): number => value + 1;
const bridgeSession = {
  banExpiresAt: null,
  banned: false,
  createdAt: new Date(signedWorkloadEpochMillis - 1000),
  emailVerified: true,
  expiresAt: new Date(signedWorkloadEpochMillis + 60_000),
  providerSubjectId: request.providerSubjectId,
  sessionId: 'session-01',
};
type ProviderVerify = CommercePortalAuthVerificationService['Service']['verifyExternalAuthentication'];
type SignedFixture = Effect.Success<ReturnType<typeof makeSignedWorkloadFixture>>;

// Source-contract doubles only: actual account/session/Attempt persistence remains the native gate.
const makeBridgeProvider = (reads: Ref.Ref<number>) =>
  commercePortalAuthVerificationProviderLive.pipe(
    Layer.provide(
      Layer.succeed(CommercePortalAuthSessionReaderService, {
        findBySessionId: () => Ref.update(reads, (count) => count + 1).pipe(Effect.as(Option.some(bridgeSession))),
      }),
    ),
    Layer.provide(
      Layer.succeed(CommerceEnrollmentProofService, {
        authorizeAccountCreation: () => Effect.fail(new CommerceEnrollmentProofRejected({})),
        verify: () => Effect.fail(new CommerceEnrollmentProofRejected({})),
        verifyBinding: () => Effect.fail(new CommerceEnrollmentProofRejected({})),
      }),
    ),
  );

const mountBridge = (
  fixture: SignedFixture,
  observe: (actual: ProviderVerify) => ProviderVerify,
  reads: Ref.Ref<number>,
  redemption?: GatewayAssertionRedemption,
) =>
  Effect.gen(function* mountRealBridge() {
    const provider = Context.get(yield* Layer.build(makeBridgeProvider(reads)), CommercePortalAuthVerificationService);
    const observed = { verifyExternalAuthentication: observe(provider.verifyExternalAuthentication) };
    const api = HttpApiBuilder.layer(CommercePortalAuthVerificationApi).pipe(
      Layer.provide(commercePortalAuthVerificationApiLive),
      Layer.provide(commercePortalAuthVerificationHttpExecutorLive),
      Layer.provideMerge(makeSignedWorkloadAuthority(fixture.environment, fixture.snapshot, redemption)),
      Layer.provideMerge(Layer.succeed(Clock.Clock, signedWorkloadClock)),
      Layer.provide(Layer.succeed(CommercePortalAuthVerificationService, observed)),
      Layer.provide(HttpServer.layerServices),
    );
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(api, { disableLogger: true })),
      (value) => Effect.promise(value.dispose.bind(value)),
    );
    return { handler, provider };
  });
const callBridge = (
  handler: Effect.Success<ReturnType<typeof mountBridge>>['handler'],
  token: string,
  body: typeof request = request,
) =>
  Effect.tryPromise(() =>
    handler.handler(
      new Request('https://commerce.ontos.test/portal-auth/internal/verify', {
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        method: 'POST',
      }),
      requestContext,
    ),
  );
const bridgeOutcome = (response: Response) =>
  Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(VerifyExternalAuthenticationResultSchema))),
  );

it.effect('resolves real provider caller authority at request time and refuses missing scope', () =>
  Effect.gen(function* exactPrivateCaller() {
    const fixture = yield* makeSignedWorkloadFixture();
    const reads = yield* Ref.make(0);
    const { handler, provider } = yield* mountBridge(fixture, (actual) => actual, reads);
    const outside = yield* provider.verifyExternalAuthentication(canonicalRequest);
    expect(outside.outcome).toBe('UNAVAILABLE');
    expect(yield* Ref.get(reads)).toBe(0);
    const response = yield* callBridge(handler, fixture.token);
    expect(response.status).toBe(200);
    expect((yield* bridgeOutcome(response)).outcome).toBe('ALLOWED');
    expect(yield* Ref.get(reads)).toBe(1);
    expect((yield* provider.verifyExternalAuthentication(canonicalRequest)).outcome).toBe('UNAVAILABLE');
    expect(yield* Ref.get(reads)).toBe(1);
  }).pipe(Effect.provideService(Clock.Clock, signedWorkloadClock)),
);

it.effect('binds every canonical provider request field before accessing owner state', () =>
  Effect.gen(function* rejectProjectionSubstitution() {
    const fixture = yield* makeSignedWorkloadFixture();
    const reads = yield* Ref.make(0);
    const changes: readonly Partial<CommercePortalAuthVerificationInput>[] = [
      { nonce: '50000000-0000-4000-8000-000000000012' },
      { providerSubjectId: 'different-provider' },
      { sessionRef: 'better-auth-session:ontos.commerce.portal.better-auth.v1:different-session' },
      { tenantId: '10000000-0000-4000-8000-000000000099' },
      { enrollmentAttemptId: '10000000-0000-4000-8000-000000000090' },
    ];
    for (const change of changes) {
      const { handler } = yield* mountBridge(fixture, (actual) => (input) => actual({ ...input, ...change }), reads);
      const response = yield* callBridge(handler, fixture.token);
      expect(response.status).toBe(200);
      expect((yield* bridgeOutcome(response)).outcome).toBe('REJECTED');
    }
    expect(yield* Ref.get(reads)).toBe(0);
  }).pipe(Effect.provideService(Clock.Clock, signedWorkloadClock)),
);

it.effect('isolates overlapping request proofs and does not leak them after completion', () =>
  Effect.gen(function* concurrentRequestProofs() {
    const fixture = yield* makeSignedWorkloadFixture();
    const reads = yield* Ref.make(0);
    const entered = yield* Ref.make(0);
    const both = yield* Deferred.make<number>();
    const other = {
      ...request,
      nonce: Schema.decodeUnknownSync(VerifyExternalAuthenticationRequestSchema)({
        ...request,
        nonce: '50000000-0000-4000-8000-000000000012',
      }).nonce,
    };
    const { handler, provider } = yield* mountBridge(
      fixture,
      (actual) => (input) =>
        Effect.gen(function* overlap() {
          const count = yield* Ref.updateAndGet(entered, incrementBridgeCounter);
          if (count === 2) {
            yield* Deferred.succeed(both, count);
          }
          yield* Deferred.await(both);
          const good = yield* actual(input);
          const swapped = yield* actual({
            ...input,
            nonce: input.nonce === request.nonce ? other.nonce : request.nonce,
          });
          expect(swapped.outcome).toBe('REJECTED');
          return good;
        }),
      reads,
    );
    const otherToken = yield* fixture.tokenFor('10000000-0000-4000-8000-000000000014');
    const responses = yield* Effect.all([callBridge(handler, fixture.token), callBridge(handler, otherToken, other)], {
      concurrency: 2,
    });
    for (const response of responses) {
      expect((yield* bridgeOutcome(response)).outcome).toBe('ALLOWED');
    }
    expect(yield* Ref.get(reads)).toBe(2);
    expect((yield* provider.verifyExternalAuthentication(canonicalRequest)).outcome).toBe('UNAVAILABLE');
  }).pipe(Effect.provideService(Clock.Clock, signedWorkloadClock)),
);

it.effect('redeems once before provider access and refuses replay or invalid credentials', () =>
  Effect.gen(function* singleRedemption() {
    const fixture = yield* makeSignedWorkloadFixture();
    const reads = yield* Ref.make(0);
    const consumed = yield* Ref.make<readonly string[]>([]);
    const redemption: GatewayAssertionRedemption = {
      consume: (input) =>
        Ref.modify(consumed, (values) => [values.includes(input.jti), [...values, input.jti]]).pipe(
          Effect.flatMap((replayed) =>
            replayed
              ? Effect.fail(new GatewayAssertionReplayError({ reason: 'Source-test replay refused' }))
              : Effect.void,
          ),
        ),
    };
    const { handler } = yield* mountBridge(fixture, (actual) => actual, reads, redemption);
    expect((yield* callBridge(handler, 'invalid-token')).status).toBe(403);
    expect(yield* Ref.get(reads)).toBe(0);
    const accepted = yield* callBridge(handler, fixture.token);
    expect(accepted.status).toBe(200);
    expect((yield* bridgeOutcome(accepted)).outcome).toBe('ALLOWED');
    expect(yield* Ref.get(reads)).toBe(1);
    expect(yield* Ref.get(consumed)).toHaveLength(1);
    expect((yield* callBridge(handler, fixture.token)).status).toBe(403);
    expect(yield* Ref.get(reads)).toBe(1);
  }).pipe(Effect.provideService(Clock.Clock, signedWorkloadClock)),
);

it.effect('mounts the gated route in the Commerce API and authenticates direct executor calls', () =>
  Effect.gen(function* productionRootBoundary() {
    expect(Object.hasOwn(commerceCustomerContextApi.groups, 'externalAuthenticationVerification')).toBe(true);
    expect(apiRuntime).toBeDefined();
    // No workload, provider, database or request proof is required to describe/build this executor.
    const executor = Context.get(
      yield* Layer.build(commercePortalAuthVerificationHttpExecutorLive),
      CommercePortalAuthVerificationHttpExecutor,
    );
    const fixture = yield* makeSignedWorkloadFixture();
    const reads = yield* Ref.make(0);
    const provider = yield* Layer.build(makeBridgeProvider(reads));
    const dependencies = makeSignedWorkloadAuthority(fixture.environment, fixture.snapshot);
    const missing = yield* executor
      .execute(
        request,
        HttpServerRequest.fromWeb(new Request('https://commerce.ontos.test/portal-auth/internal/verify')),
      )
      .pipe(Effect.provide(dependencies), Effect.provideContext(provider), Effect.flip);
    expect(missing.status).toBe(401);
    const invalid = yield* executor
      .execute(
        request,
        HttpServerRequest.fromWeb(
          new Request('https://commerce.ontos.test/portal-auth/internal/verify', {
            headers: { authorization: 'Bearer invalid-token' },
          }),
        ),
      )
      .pipe(Effect.provide(dependencies), Effect.provideContext(provider), Effect.flip);
    expect(invalid.status).toBe(403);
    expect(yield* Ref.get(reads)).toBe(0);
  }).pipe(Effect.provideService(Clock.Clock, signedWorkloadClock)),
);
