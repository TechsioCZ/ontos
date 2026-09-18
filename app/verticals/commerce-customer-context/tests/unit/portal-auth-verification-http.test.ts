import {
  assertAuthenticationAdmission,
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
  TrustedAdmissionObservation,
} from '@app/core-runtime/auth/external-identity-admission';
import type { TrustedAdmissionObservationService } from '@app/core-runtime/auth/external-identity-admission';
import {
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import type { GatewayAssertionRedemption } from '@app/core-runtime/auth/gateway-assertion-redemption';
import {
  AuthenticationAdmissionObservationSchema,
  AuthenticationNamespaceIdSchema,
  AuthenticationNamespaceRegistrationSchema,
  AuthBindingIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { OperationAuthenticationRequired, OperationContextUnavailable } from '@app/core-runtime';
import { ConfigProvider, Context, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import type { Clock } from 'effect';
import { expect, it } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { makeGatewayPrincipalVerifierLayer } from '@app/gateway-principal-verifier/server';
import type { ExternalOperationAuthenticationRequest } from '@app/core-runtime/operations/external-authentication';
import { commercePortalAuthAdmissionAdapterLive } from '../../api/portal-auth/admission/adapter.ts';
import { CommercePortalAuthAdmissionAdapter } from '../../api/portal-auth/admission/adapter-service.ts';
import type { CommercePortalAuthAdmissionAdapterService } from '../../api/portal-auth/admission/adapter-service.ts';
import { commercePortalAuthAdmissionObservationLive } from '../../api/portal-auth/admission/observation.ts';
import { CommercePortalAuthBindingProjectionResolver } from '../../api/portal-auth/admission/projection-resolver.ts';
import type { CommercePortalAuthBindingProjection } from '../../api/portal-auth/admission/projection-resolver.ts';
import { CommercePortalAuthTrustedAdmissionConfigurationService } from '../../api/portal-auth/admission/trusted-config.ts';
import {
  CommercePortalAuthVerificationWorkloadRejected,
  CommercePortalAuthVerificationWorkloadUnavailable,
  CommercePortalAuthVerificationWorkloadAuthorization,
  commercePortalAuthVerificationWorkloadAuthorizationLive,
} from '../../api/portal-auth/verification-http/workload-authorization.ts';
import {
  CommercePortalAuthVerificationWorkloadGrantConfiguration,
  CommercePortalAuthVerificationWorkloadGrantsSchema,
} from '../../api/portal-auth/verification-http/workload-grants.ts';
import {
  CommercePortalAuthVerificationClient,
  CommercePortalAuthVerificationClientUnavailable,
} from '../../src/api/portal-auth-verification/client.ts';
import type { CommercePortalAuthVerificationClientPort } from '../../src/api/portal-auth-verification/client.ts';
import { CommercePortalAuthVerificationRequestSchema } from '../../shared/portal-auth-verification.ts';
import type { CommercePortalAuthVerificationRequest } from '../../shared/portal-auth-verification.ts';
import {
  COMMERCE_ADMISSION_DEADLINE_MS,
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  VerifyExternalAuthenticationResultSchema,
} from '../../shared/portal-auth-contracts.ts';
import type { VerifyExternalAuthenticationResult } from '../../shared/portal-auth-contracts.ts';

const now = DateTime.makeUnsafe('2026-09-17T09:00:00.000Z');
const attesterPrincipalId = '10000000-0000-4000-8000-000000000001';
const namespaceId = Schema.decodeUnknownSync(AuthenticationNamespaceIdSchema)(COMMERCE_AUTHENTICATION_NAMESPACE_ID);
const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('10000000-0000-4000-8000-000000000002');
const principalId = Schema.decodeUnknownSync(PrincipalIdSchema)('10000000-0000-4000-8000-000000000003');
const authBindingId = Schema.decodeUnknownSync(AuthBindingIdSchema)('10000000-0000-4000-8000-000000000004');
const substitutedAuthBindingId = Schema.decodeUnknownSync(AuthBindingIdSchema)('10000000-0000-4000-8000-000000000006');
const substitutedPrincipalId = Schema.decodeUnknownSync(PrincipalIdSchema)('10000000-0000-4000-8000-000000000005');
const providerSubjectId = 'provider-subject-01';
const sessionId = 'session-01';
const sessionRef = `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:${sessionId}`;
const substitutedSessionRef = `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:session-02`;

const clock: Clock.Clock = {
  currentTimeMillis: Effect.succeed(DateTime.toEpochMillis(now)),
  currentTimeMillisUnsafe: () => DateTime.toEpochMillis(now),
  currentTimeNanos: Effect.succeed(BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n,
  sleep: () => Effect.void,
};

// Clock.Reference has a `never` identifier in Effect 4; this typed key retains
// the built-in `effect/Clock` runtime key while allowing the test to discharge
// the adapter's explicit Clock environment requirement.
const commerceClock = Context.Service<Clock.Clock>('effect/Clock');

const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId,
  authContextRef: sessionRef,
  authenticationNamespaceId: namespaceId,
  authMethod: 'session',
  principalId,
  tenantId,
});

const substitutedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  ...principal,
  principalId: substitutedPrincipalId,
});

const registration = Schema.decodeUnknownSync(AuthenticationNamespaceRegistrationSchema)({
  allowedAudiences: ['commerce-customer-context'],
  authenticationNamespaceId: namespaceId,
  provider: 'better-auth',
  requiresOperationAdmission: true,
  reservationPrincipalKind: 'human',
  subjectTypes: ['user'],
  trustedAttesterPrincipalIds: [attesterPrincipalId],
});

const registry = makeAuthenticationNamespaceRegistry([registration]);

const makeRequest = (nonce: string, operationRef: string): ExternalOperationAuthenticationRequest => ({
  audience: 'commerce-customer-context',
  authBindingId,
  authContextRef: sessionRef,
  authenticationNamespaceId: namespaceId,
  nonce,
  operationRef,
  principal,
  principalId,
  subjectType: 'user',
  tenantId,
});

const admissionMatch = (request: ExternalOperationAuthenticationRequest, bindingRevision: number) => ({
  audience: request.audience,
  authBindingId: request.authBindingId,
  authContextRef: request.authContextRef,
  authenticationNamespaceId: request.authenticationNamespaceId,
  bindingRevision,
  nonce: request.nonce,
  operationRef: request.operationRef,
  principalId: request.principalId,
  tenantId: request.tenantId,
});

const makeProviderRequest = (request: ExternalOperationAuthenticationRequest): CommercePortalAuthVerificationRequest =>
  Schema.decodeUnknownSync(CommercePortalAuthVerificationRequestSchema)({
    audience: request.audience,
    authenticationNamespaceId: request.authenticationNamespaceId,
    nonce: request.nonce,
    operation: 'commerce-portal-authentication.verify-external-authentication.v1',
    operationRef: request.operationRef,
    providerSubjectId,
    sessionRef,
    subjectType: 'user',
    tenantId: request.tenantId,
  });

const makeAllowedProviderResult = (
  request: CommercePortalAuthVerificationRequest,
  overrides: {
    readonly observedAt?: Schema.Schema.Type<typeof Schema.DateTimeUtc>;
    readonly providerSubjectId?: string;
    readonly sessionRef?: string;
  } = {},
): VerifyExternalAuthenticationResult =>
  Schema.decodeUnknownSync(VerifyExternalAuthenticationResultSchema)({
    authenticatedAt: now,
    authenticationNamespaceId: request.authenticationNamespaceId,
    emailVerified: true,
    nonce: request.nonce,
    observedAt: overrides.observedAt ?? now,
    outcome: 'ALLOWED',
    providerSubjectId: overrides.providerSubjectId ?? request.providerSubjectId,
    sessionRef: overrides.sessionRef ?? request.sessionRef,
    subjectType: request.subjectType,
    tenantId: request.tenantId,
  });

const defaultProjection: CommercePortalAuthBindingProjection = {
  bindingRevision: 1,
  providerSubjectId,
  sessionRef,
};

const makeProjectionResolver = (projection: CommercePortalAuthBindingProjection | undefined) => ({
  resolve: () => projection,
});

const makeMissingProjectionResolver = () => ({
  resolve: (): CommercePortalAuthBindingProjection | undefined => Option.getOrUndefined(Option.none()),
});

const makeAdapter = (
  projectionResolver = makeProjectionResolver(defaultProjection),
): Effect.Effect<CommercePortalAuthAdmissionAdapterService> =>
  Effect.service(CommercePortalAuthAdmissionAdapter).pipe(
    Effect.provide(
      commercePortalAuthAdmissionAdapterLive.pipe(
        Layer.provide(Layer.succeed(CommercePortalAuthBindingProjectionResolver, projectionResolver)),
        Layer.provide(
          Layer.succeed(CommercePortalAuthTrustedAdmissionConfigurationService, {
            attesterPrincipalId,
            maxAdmissionWindowMillis: COMMERCE_ADMISSION_DEADLINE_MS,
          }),
        ),
      ),
    ),
  );

const makeObservation = (
  client: CommercePortalAuthVerificationClientPort,
  projectionResolver = makeProjectionResolver(defaultProjection),
): Effect.Effect<TrustedAdmissionObservationService> =>
  Effect.service(TrustedAdmissionObservation).pipe(
    Effect.provide(
      commercePortalAuthAdmissionObservationLive.pipe(
        Layer.provide(Layer.succeed(CommercePortalAuthBindingProjectionResolver, projectionResolver)),
        Layer.provide(Layer.succeed(CommercePortalAuthVerificationClient, client)),
      ),
    ),
  );

const verifyWith = (
  client: CommercePortalAuthVerificationClientPort,
  request: ExternalOperationAuthenticationRequest,
  projectionResolver = makeProjectionResolver(defaultProjection),
) =>
  Effect.provideService(
    Effect.gen(function* verifyWithDependencies() {
      const adapter = yield* makeAdapter(projectionResolver);
      const observation = yield* makeObservation(client, projectionResolver);
      return yield* Effect.provideService(
        Effect.provideService(
          Effect.provideService(adapter.verify(request), AuthenticationNamespaceRegistry, registry),
          commerceClock,
          clock,
        ),
        TrustedAdmissionObservation,
        observation,
      );
    }),
    commerceClock,
    clock,
  );

it.effect('publishes the exact provider request and mints only an operation-bound Core capability', () =>
  Effect.gen(function* exactProviderRequest() {
    const calls: CommercePortalAuthVerificationRequest[] = [];
    const client: CommercePortalAuthVerificationClientPort = {
      verify: (request) => {
        calls.push(request);
        return Effect.succeed(makeAllowedProviderResult(request));
      },
    };
    const request = makeRequest('50000000-0000-4000-8000-000000000001', 'operation-1');
    const admission = yield* verifyWith(client, request);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      audience: request.audience,
      authenticationNamespaceId: request.authenticationNamespaceId,
      nonce: request.nonce,
      operation: 'commerce-portal-authentication.verify-external-authentication.v1',
      operationRef: request.operationRef,
      providerSubjectId,
      sessionRef,
      subjectType: 'user',
      tenantId,
    });
    expect(Schema.is(AuthenticationAdmissionObservationSchema)(admission)).toBe(false);
    yield* assertAuthenticationAdmission(admission, admissionMatch(request, 1));
  }).pipe(Effect.provideService(commerceClock, clock)),
);

it.effect('rejects a trusted principal substitution before making a provider call', () =>
  Effect.gen(function* principalSubstitution() {
    let calls = 0;
    const client: CommercePortalAuthVerificationClientPort = {
      verify: () => {
        calls += 1;
        return Effect.fail(new CommercePortalAuthVerificationClientUnavailable({ reason: 'must not be called' }));
      },
    };
    const request = makeRequest('50000000-0000-4000-8000-000000000002', 'operation-2');
    const error = yield* Effect.flip(
      verifyWith(client, {
        ...request,
        principal: substitutedPrincipal,
      }),
    );

    expect(error).toBeInstanceOf(OperationAuthenticationRequired);

    const bindingError = yield* Effect.flip(
      verifyWith(client, {
        ...request,
        principal: {
          ...principal,
          authBindingId: substitutedAuthBindingId,
        },
      }),
    );

    expect(bindingError).toBeInstanceOf(OperationAuthenticationRequired);
    expect(calls).toBe(0);
  }).pipe(Effect.provideService(commerceClock, clock)),
);

it.effect('fails closed when the observation resolver changes the projection before provider verification', () =>
  Effect.gen(function* changingProjection() {
    let resolveCount = 0;
    let providerCalls = 0;
    const changingResolver = {
      resolve: () => {
        resolveCount += 1;
        return resolveCount === 1
          ? defaultProjection
          : {
              ...defaultProjection,
              sessionRef: substitutedSessionRef,
            };
      },
    };
    const client: CommercePortalAuthVerificationClientPort = {
      verify: () => {
        providerCalls += 1;
        return Effect.succeed(
          makeAllowedProviderResult(
            makeProviderRequest(makeRequest('50000000-0000-4000-8000-00000000000a', 'operation-changing')),
          ),
        );
      },
    };
    const error = yield* Effect.flip(
      verifyWith(client, makeRequest('50000000-0000-4000-8000-00000000000a', 'operation-changing'), changingResolver),
    );

    expect(error).toBeInstanceOf(OperationAuthenticationRequired);
    expect(resolveCount).toBe(2);
    expect(providerCalls).toBe(0);
  }).pipe(Effect.provideService(commerceClock, clock)),
);

it.effect('rejects a malformed projection subject before provider verification', () =>
  Effect.gen(function* malformedProjection() {
    let providerCalls = 0;
    const client: CommercePortalAuthVerificationClientPort = {
      verify: () => {
        providerCalls += 1;
        return Effect.succeed(
          makeAllowedProviderResult(
            makeProviderRequest(makeRequest('50000000-0000-4000-8000-00000000000b', 'operation-malformed')),
          ),
        );
      },
    };
    const error = yield* Effect.flip(
      verifyWith(
        client,
        makeRequest('50000000-0000-4000-8000-00000000000b', 'operation-malformed'),
        makeProjectionResolver({
          ...defaultProjection,
          providerSubjectId: '',
        }),
      ),
    );

    expect(error).toBeInstanceOf(OperationAuthenticationRequired);
    expect(providerCalls).toBe(0);
  }).pipe(Effect.provideService(commerceClock, clock)),
);

it.effect('rejects an ALLOWED replay and subject substitution from the provider', () =>
  Effect.gen(function* providerSubstitution() {
    const firstRequest = makeRequest('50000000-0000-4000-8000-000000000003', 'operation-3');
    const secondRequest = makeRequest('50000000-0000-4000-8000-000000000004', 'operation-4');
    const replayedResult = makeAllowedProviderResult(makeProviderRequest(firstRequest));
    const replayingClient: CommercePortalAuthVerificationClientPort = {
      verify: () => Effect.succeed(replayedResult),
    };
    const replayError = yield* Effect.flip(verifyWith(replayingClient, secondRequest));
    expect(replayError).toBeInstanceOf(OperationAuthenticationRequired);

    const substitutedClient: CommercePortalAuthVerificationClientPort = {
      verify: (request) =>
        Effect.succeed(
          makeAllowedProviderResult(request, {
            providerSubjectId: 'provider-subject-substituted',
            sessionRef: substitutedSessionRef,
          }),
        ),
    };
    const substitutionError = yield* Effect.flip(
      verifyWith(substitutedClient, makeRequest('50000000-0000-4000-8000-000000000005', 'operation-5')),
    );
    expect(substitutionError).toBeInstanceOf(OperationAuthenticationRequired);
  }).pipe(Effect.provideService(commerceClock, clock)),
);

it.effect('rejects expired and future ALLOWED observations at the receiver clock', () =>
  Effect.gen(function* observationFreshness() {
    const expiredClient: CommercePortalAuthVerificationClientPort = {
      verify: (request) =>
        Effect.succeed(
          makeAllowedProviderResult(request, {
            observedAt: DateTime.add(now, { milliseconds: -(COMMERCE_ADMISSION_DEADLINE_MS + 1) }),
          }),
        ),
    };
    const expiredError = yield* Effect.flip(
      verifyWith(expiredClient, makeRequest('50000000-0000-4000-8000-000000000006', 'operation-6')),
    );
    expect(expiredError).toBeInstanceOf(OperationAuthenticationRequired);

    const futureClient: CommercePortalAuthVerificationClientPort = {
      verify: (request) =>
        Effect.succeed(
          makeAllowedProviderResult(request, {
            observedAt: DateTime.add(now, { milliseconds: 1 }),
          }),
        ),
    };
    const futureError = yield* Effect.flip(
      verifyWith(futureClient, makeRequest('50000000-0000-4000-8000-000000000007', 'operation-7')),
    );
    expect(futureError).toBeInstanceOf(OperationAuthenticationRequired);
  }).pipe(Effect.provideService(commerceClock, clock)),
);

it.effect('maps provider outage and missing trusted projection to typed fail-closed errors', () =>
  Effect.gen(function* outageAndMissingProjection() {
    let outageCalls = 0;
    const outageClient: CommercePortalAuthVerificationClientPort = {
      verify: () => {
        outageCalls += 1;
        return Effect.fail(new CommercePortalAuthVerificationClientUnavailable({ reason: 'provider unavailable' }));
      },
    };
    const outage = yield* Effect.flip(
      verifyWith(outageClient, makeRequest('50000000-0000-4000-8000-000000000008', 'operation-8')),
    );
    expect(outage).toBeInstanceOf(OperationContextUnavailable);

    const missingProjection = yield* Effect.flip(
      verifyWith(
        outageClient,
        makeRequest('50000000-0000-4000-8000-000000000009', 'operation-9'),
        makeMissingProjectionResolver(),
      ),
    );
    expect(missingProjection).toBeInstanceOf(OperationContextUnavailable);
    expect(outageCalls).toBe(1);
  }).pipe(Effect.provideService(commerceClock, clock)),
);

const workloadAuthenticationNamespaceId = Schema.decodeUnknownSync(AuthenticationNamespaceIdSchema)(
  'ontos.staff.gateway-api-key.v1',
);
const workloadPrincipalId = Schema.decodeUnknownSync(PrincipalIdSchema)('10000000-0000-4000-8000-000000000010');
const workloadAuthBindingId = '10000000-0000-4000-8000-000000000011';
const workloadTenantId = '10000000-0000-4000-8000-000000000012';
const workloadIssuer = 'https://shell.ontos.test';
const workloadProviderEndpointAudience = 'commerce-portal-auth-verification';
const defaultRedemption: GatewayAssertionRedemption = { consume: () => Effect.void };

const makeWorkloadFixture = (
  authMethod: 'api_key' | 'session' | 'support_impersonation' = 'api_key',
  impersonatedByPrincipalId?: string,
) =>
  Effect.gen(function* makeWorkloadFixtureEffect() {
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'commerce-workload-test',
      use: 'sig',
    };
    const issuedAt = Math.floor((yield* DateTime.nowAsDate).getTime() / 1000);
    const workloadPrincipalBase = {
      authBindingId: workloadAuthBindingId,
      authContextRef: 'gateway-api-key:commerce-workload-test',
      authenticationNamespaceId: workloadAuthenticationNamespaceId,
      authMethod,
      principalId: workloadPrincipalId,
      tenantId: workloadTenantId,
    };
    const workloadPrincipal =
      impersonatedByPrincipalId === undefined
        ? workloadPrincipalBase
        : { ...workloadPrincipalBase, impersonatedByPrincipalId };
    const token = yield* Effect.promise(() =>
      new SignJWT({ principal: workloadPrincipal, ver: EXTERNAL_GATEWAY_ASSERTION_VERSION })
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

const workloadGrantConfiguration = Schema.decodeUnknownSync(CommercePortalAuthVerificationWorkloadGrantsSchema)({
  grants: [
    {
      commerceAuthenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      operation: 'commerce-portal-authentication.verify-external-authentication.v1',
      receivingAudience: 'commerce-customer-context',
      tenantId: workloadTenantId,
      workloadAuthenticationNamespaceId,
      workloadPrincipalId,
    },
  ],
  providerEndpointAudience: workloadProviderEndpointAudience,
});

const runWorkloadAuthorization = (
  authorization: string,
  request: CommercePortalAuthVerificationRequest,
  grantConfiguration = workloadGrantConfiguration,
  redemption: GatewayAssertionRedemption = defaultRedemption,
) =>
  Effect.gen(function* runWorkloadAuthorizationEffect() {
    const authority = yield* CommercePortalAuthVerificationWorkloadAuthorization;
    return yield* authority.authorize({
      authorization: Redacted.make(authorization),
      request,
      requestCorrelation: 'workload-authorization-test',
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        commercePortalAuthVerificationWorkloadAuthorizationLive,
        Layer.succeed(CommercePortalAuthVerificationWorkloadGrantConfiguration, grantConfiguration),
        Layer.succeed(GatewayAssertionRedemptionService, redemption),
      ),
    ),
  );

it.effect('authorizes only a fresh, exact api_key workload grant', () =>
  Effect.gen(function* exactWorkloadGrant() {
    const fixture = yield* makeWorkloadFixture();
    const request = Schema.decodeUnknownSync(CommercePortalAuthVerificationRequestSchema)({
      audience: 'commerce-customer-context',
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      nonce: '50000000-0000-4000-8000-000000000010',
      operation: 'commerce-portal-authentication.verify-external-authentication.v1',
      operationRef: 'workload-operation-1',
      providerSubjectId,
      sessionRef,
      subjectType: 'user',
      tenantId: workloadTenantId,
    });
    const verifierLayer = makeGatewayPrincipalVerifierLayer(ConfigProvider.fromUnknown(fixture.environment));
    const allowed = yield* runWorkloadAuthorization(`Bearer ${fixture.token}`, request).pipe(
      Effect.provide(verifierLayer),
    );
    expect(allowed).toBeUndefined();

    const replay = yield* Effect.flip(
      runWorkloadAuthorization(`Bearer ${fixture.token}`, request, workloadGrantConfiguration, {
        consume: () =>
          Effect.fail(
            new GatewayAssertionReplayError({
              reason: 'replayed workload assertion',
            }),
          ),
      }).pipe(Effect.provide(verifierLayer)),
    );
    expect(Schema.is(CommercePortalAuthVerificationWorkloadRejected)(replay)).toBe(true);

    const wrongAudience = yield* Effect.flip(
      runWorkloadAuthorization(`Bearer ${fixture.token}`, {
        ...request,
        audience: 'another-commerce-receiver',
      }).pipe(Effect.provide(verifierLayer)),
    );
    expect(Schema.is(CommercePortalAuthVerificationWorkloadRejected)(wrongAudience)).toBe(true);

    const wrongTenant = yield* Effect.flip(
      runWorkloadAuthorization(
        `Bearer ${fixture.token}`,
        Schema.decodeUnknownSync(CommercePortalAuthVerificationRequestSchema)({
          ...request,
          tenantId: '10000000-0000-4000-8000-000000000014',
        }),
      ).pipe(Effect.provide(verifierLayer)),
    );
    expect(Schema.is(CommercePortalAuthVerificationWorkloadRejected)(wrongTenant)).toBe(true);

    const sessionFixture = yield* makeWorkloadFixture('session');
    const sessionVerifierLayer = makeGatewayPrincipalVerifierLayer(
      ConfigProvider.fromUnknown(sessionFixture.environment),
    );
    const sessionPrincipal = yield* Effect.flip(
      runWorkloadAuthorization(`Bearer ${sessionFixture.token}`, request).pipe(Effect.provide(sessionVerifierLayer)),
    );
    expect(Schema.is(CommercePortalAuthVerificationWorkloadRejected)(sessionPrincipal)).toBe(true);

    const impersonationFixture = yield* makeWorkloadFixture(
      'support_impersonation',
      '10000000-0000-4000-8000-000000000015',
    );
    const impersonationVerifierLayer = makeGatewayPrincipalVerifierLayer(
      ConfigProvider.fromUnknown(impersonationFixture.environment),
    );
    const impersonationPrincipal = yield* Effect.flip(
      runWorkloadAuthorization(`Bearer ${impersonationFixture.token}`, request).pipe(
        Effect.provide(impersonationVerifierLayer),
      ),
    );
    expect(Schema.is(CommercePortalAuthVerificationWorkloadRejected)(impersonationPrincipal)).toBe(true);

    const emptyConfiguration = yield* Effect.flip(
      runWorkloadAuthorization(`Bearer ${fixture.token}`, request, {
        ...workloadGrantConfiguration,
        grants: [],
      }).pipe(Effect.provide(verifierLayer)),
    );
    expect(Schema.is(CommercePortalAuthVerificationWorkloadRejected)(emptyConfiguration)).toBe(true);

    const unavailable = yield* Effect.flip(
      runWorkloadAuthorization(`Bearer ${fixture.token}`, request, workloadGrantConfiguration, {
        consume: () =>
          Effect.fail(
            new GatewayAssertionRedemptionUnavailableError({
              reason: 'redemption unavailable',
            }),
          ),
      }).pipe(Effect.provide(verifierLayer)),
    );
    expect(Schema.is(CommercePortalAuthVerificationWorkloadUnavailable)(unavailable)).toBe(true);
  }),
);
