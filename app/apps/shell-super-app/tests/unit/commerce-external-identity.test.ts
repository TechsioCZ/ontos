import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { AuthenticationAdmissionRequest } from '@app/core-runtime/auth/external-identity-admission';
import {
  AuthenticationNamespaceRegistry,
  TrustedExternalSubjectAdmissionService,
} from '@app/core-runtime/auth/external-identity-admission';
import {
  AuthenticationAdmissionObservationSchema,
  AuthenticationNamespaceIdSchema,
  AuthBindingIdSchema,
  PrincipalIdSchema,
  ProviderSubjectIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  VerifyExternalAuthenticationResultSchema,
} from '@app/commerce-customer-context/portal-auth/contracts';
import {
  COMMERCE_PORTAL_AUTH_VERIFY_OPERATION,
  CommercePortalAuthVerificationRequestSchema,
} from '@app/commerce-customer-context/portal-auth/verification';
import { CommercePortalAuthVerificationWorkloadAssertion } from '@app/commerce-customer-context/portal-auth/verification/client';
import type { CommercePortalAuthVerificationClient } from '@app/commerce-customer-context/portal-auth/verification/client';
import { Clock, DateTime, Effect, Layer, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CommerceExternalIdentityConfigurationSchema,
  makeCommerceAuthenticationNamespaceRegistration,
  makeCommerceAuthenticationNamespaceRegistry,
  commerceExternalIdentityDeploymentLayer,
  makeCommerceExternalIdentityWorkloadAssertionLayer,
} from '../../api/auth/commerce-external-identity.ts';
import { makeCommerceAdmissionObservationService } from '../../api/auth/external-identity/commerce-admission-observation.ts';
import { ExternalIdentityWorkloadAuthorization } from '../../api/auth/external-identity/workload-authorization.ts';
import type { ExternalIdentityWorkloadAuthorizationService } from '../../api/auth/external-identity/workload-authorization.ts';
import {
  ExternalIdentityHttpWorkloadContext,
  provideExternalIdentityHttpWorkload,
} from '../../api/auth/external-identity/request-context.ts';
import type { ExternalIdentityHttpWorkloadContextValue } from '../../api/auth/external-identity/request-context.ts';
import { GatewayIssuer } from '../../api/auth/gateway-issuer.ts';
import { FetchHttpClient } from 'effect/unstable/http';

type CommercePortalAuthVerificationClientPort = CommercePortalAuthVerificationClient['Service'];
type CommercePortalAuthVerificationRequest = Schema.Schema.Type<typeof CommercePortalAuthVerificationRequestSchema>;
type VerifyExternalAuthenticationResult = Schema.Schema.Type<typeof VerifyExternalAuthenticationResultSchema>;

const decode = <S extends Schema.ConstraintDecoder<unknown>, Value>(schema: S, input: Value): S['Type'] =>
  Schema.decodeUnknownSync(schema)(input);

const namespaceId = decode(AuthenticationNamespaceIdSchema, COMMERCE_AUTHENTICATION_NAMESPACE_ID);
const workloadNamespaceId = decode(AuthenticationNamespaceIdSchema, 'ontos.staff.gateway-api-key.v1');
const tenantId = decode(TenantIdSchema, '10000000-0000-4000-8000-000000000001');
const workloadPrincipalId = decode(PrincipalIdSchema, '10000000-0000-4000-8000-000000000002');
const authBindingId = decode(AuthBindingIdSchema, '10000000-0000-4000-8000-000000000003');
const boundPrincipalId = decode(PrincipalIdSchema, '10000000-0000-4000-8000-000000000004');
const attesterPrincipalId = decode(PrincipalIdSchema, '10000000-0000-4000-8000-000000000005');
const providerSubjectId = 'commerce-user-01';
const sessionRef = `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:session-01`;
const providerEndpointAudience = 'commerce-customer-context';
const gatewayAudience = 'party-registry';
const now = DateTime.makeUnsafe('2026-09-17T09:00:00.000Z');
const nowMillis = DateTime.toEpochMillis(now);
const fixedClock: Clock.Clock = {
  currentTimeMillis: Effect.succeed(nowMillis),
  currentTimeMillisUnsafe: () => nowMillis,
  currentTimeNanos: Effect.succeed(BigInt(nowMillis) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(nowMillis) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(nowMillis) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(nowMillis) * 1_000_000n,
  sleep: () => Effect.never,
};

const rawConfiguration = {
  attesterPrincipalId,
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  grants: [
    {
      operation: 'resolve',
      receivingAudience: providerEndpointAudience,
      targetAuthenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      tenantId,
      workloadAuthenticationNamespaceId: workloadNamespaceId,
      workloadPrincipalId,
    },
    {
      operation: 'gateway-context',
      receivingAudience: providerEndpointAudience,
      targetAudience: gatewayAudience,
      targetAuthenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      tenantId,
      workloadAuthenticationNamespaceId: workloadNamespaceId,
      workloadPrincipalId,
    },
  ],
  providerEndpointAudience,
  providerOrigin: 'https://commerce.example.test',
};
const configuration = decode(CommerceExternalIdentityConfigurationSchema, rawConfiguration);

const workloadPrincipal = decode(TrustedPrincipalContextSchema, {
  authBindingId: '10000000-0000-4000-8000-000000000006',
  authContextRef: 'better-auth-api-key:commerce-workload-01',
  authenticationNamespaceId: workloadNamespaceId,
  authMethod: 'api_key',
  principalId: workloadPrincipalId,
  tenantId,
});

const makeContext = (overrides: Partial<ExternalIdentityHttpWorkloadContextValue> = {}) => ({
  authenticationRef: sessionRef,
  binding: {
    authBindingId,
    bindingRevision: 7,
    principalId: boundPrincipalId,
  },
  operation: 'gateway-context' as const,
  principal: workloadPrincipal,
  providerSubjectId,
  targetAudience: gatewayAudience,
  targetAuthenticationNamespaceId: namespaceId,
  ...overrides,
});

/**
 * The audience a verification request actually carries is the one Commerce *receives* it on —
 * `makeProviderRequest` in `external-identity/commerce-admission-observation.ts` always builds it
 * with `providerEndpointAudience`, and the gateway assertion is minted for that same audience.
 * A downstream `targetAudience` never reaches this field.
 */
const makeProviderRequest = (audience = providerEndpointAudience): CommercePortalAuthVerificationRequest =>
  decode(CommercePortalAuthVerificationRequestSchema, {
    audience,
    authenticationNamespaceId: namespaceId,
    nonce: '20000000-0000-4000-8000-000000000001',
    operation: COMMERCE_PORTAL_AUTH_VERIFY_OPERATION,
    operationRef: 'commerce-operation-01',
    providerSubjectId,
    sessionRef,
    subjectType: 'user',
    tenantId,
  });

const makeAllowedResult = (request: CommercePortalAuthVerificationRequest): VerifyExternalAuthenticationResult =>
  decode(VerifyExternalAuthenticationResultSchema, {
    authenticatedAt: now,
    authenticationNamespaceId: request.authenticationNamespaceId,
    emailVerified: true,
    nonce: request.nonce,
    observedAt: now,
    outcome: 'ALLOWED',
    providerSubjectId: request.providerSubjectId,
    sessionRef: request.sessionRef,
    subjectType: request.subjectType,
    tenantId: request.tenantId,
  });

it.effect('registers Commerce audiences from the explicit provider and gateway grants', () =>
  Effect.sync(() => {
    const registration = makeCommerceAuthenticationNamespaceRegistration(configuration);
    expect(registration.authenticationNamespaceId).toBe(namespaceId);
    expect(registration.allowedAudiences).toEqual([providerEndpointAudience, gatewayAudience]);
    expect(registration.trustedAttesterPrincipalIds).toEqual([attesterPrincipalId]);
    expect(registration.subjectTypes).toEqual(['user']);
  }),
);

it.effect('mints a fresh Commerce audience assertion for every exact workload call', () =>
  Effect.gen(function* freshWorkloadAssertion() {
    const authorizationCalls: { operation: string; targetAudience?: string }[] = [];
    const issueCalls: { audience: string; principal: unknown }[] = [];
    const authorization: ExternalIdentityWorkloadAuthorizationService = {
      authenticate: () => Effect.succeed(workloadPrincipal),
      authorize: () => Effect.succeed(workloadPrincipal),
      authorizePrincipal: (principal, input) => {
        authorizationCalls.push(input);
        return Effect.succeed(principal);
      },
    };
    const issuer: GatewayIssuer['Service'] = {
      issue: <Principal>({ audience, principal }: { audience: string; principal: Principal }) => {
        issueCalls.push({ audience, principal });
        return Effect.succeed({ expiresAt: 300, token: `commerce-workload-token-${issueCalls.length}` });
      },
    };
    const request = makeProviderRequest();
    const acquire = Effect.gen(function* acquireAssertion() {
      const assertion = yield* Effect.service(
        // The layer itself has no ambient network dependency; this test exercises the assertion seam directly.
        CommercePortalAuthVerificationWorkloadAssertion,
      );
      const first = yield* assertion.acquire({ request, requestCorrelation: 'correlation-01' });
      const second = yield* assertion.acquire({ request, requestCorrelation: 'correlation-01' });
      return { first, second };
    }).pipe(
      Effect.provide(makeCommerceExternalIdentityWorkloadAssertionLayer(configuration)),
      Effect.provideService(ExternalIdentityWorkloadAuthorization, authorization),
      Effect.provideService(GatewayIssuer, issuer),
      Effect.provideService(ExternalIdentityHttpWorkloadContext, makeContext()),
    );
    const { first, second } = yield* acquire;

    expect(Redacted.value(first)).toBe('Bearer commerce-workload-token-1');
    expect(Redacted.value(second)).toBe('Bearer commerce-workload-token-2');
    expect(authorizationCalls).toEqual([
      {
        operation: 'gateway-context',
        targetAudience: gatewayAudience,
        targetAuthenticationNamespaceId: namespaceId,
      },
      {
        operation: 'gateway-context',
        targetAudience: gatewayAudience,
        targetAuthenticationNamespaceId: namespaceId,
      },
    ]);
    expect(issueCalls).toHaveLength(2);
    expect(issueCalls[0]).toEqual({ audience: providerEndpointAudience, principal: workloadPrincipal });
    expect(issueCalls[1]).toEqual({ audience: providerEndpointAudience, principal: workloadPrincipal });
  }),
);

/**
 * A `gateway-context` call names a downstream audience the grant keeps distinct from the Commerce
 * endpoint's own. The assertion is nevertheless minted for — and the request received on — the
 * Commerce endpoint audience, so that is the only audience this guard may compare. Comparing the
 * downstream target instead closed every gateway-context call as `identity_unavailable`.
 */
it.effect('admits a gateway-context assertion audienced for the Commerce verification endpoint', () =>
  Effect.gen(function* gatewayContextAssertionAudience() {
    const issueCalls: { audience: string; principal: unknown }[] = [];
    const authorization: ExternalIdentityWorkloadAuthorizationService = {
      authenticate: () => Effect.succeed(workloadPrincipal),
      authorize: () => Effect.succeed(workloadPrincipal),
      authorizePrincipal: (principal) => Effect.succeed(principal),
    };
    const issuer: GatewayIssuer['Service'] = {
      issue: <Principal>({ audience, principal }: { audience: string; principal: Principal }) => {
        issueCalls.push({ audience, principal });
        return Effect.succeed({ expiresAt: 300, token: `commerce-gateway-token-${issueCalls.length}` });
      },
    };
    const acquireFor = (request: CommercePortalAuthVerificationRequest) =>
      Effect.gen(function* acquireGatewayAssertion() {
        const assertion = yield* Effect.service(CommercePortalAuthVerificationWorkloadAssertion);
        return yield* assertion.acquire({ request, requestCorrelation: 'correlation-gateway' });
      }).pipe(
        Effect.provide(makeCommerceExternalIdentityWorkloadAssertionLayer(configuration)),
        Effect.provideService(ExternalIdentityWorkloadAuthorization, authorization),
        Effect.provideService(GatewayIssuer, issuer),
        // `targetAudience` is the downstream gateway audience the grant declares.
        Effect.provideService(ExternalIdentityHttpWorkloadContext, makeContext()),
      );

    const admitted = yield* acquireFor(makeProviderRequest(providerEndpointAudience));
    expect(Redacted.value(admitted)).toBe('Bearer commerce-gateway-token-1');
    expect(issueCalls).toEqual([{ audience: providerEndpointAudience, principal: workloadPrincipal }]);

    // An assertion minted for any other audience is still refused: the guard is a real check.
    const refused = yield* Effect.result(acquireFor(makeProviderRequest(gatewayAudience)));
    expect(Result.isFailure(refused)).toBe(true);
    if (Result.isFailure(refused)) {
      expect(refused.failure.reason).toBe('The external identity receiving audience changed during admission');
    }
    expect(issueCalls).toHaveLength(1);
  }),
);

it.effect('projects an ALLOWED Commerce response into a binding revision bound to the request context', () =>
  Effect.gen(function* commerceObservation() {
    const calls: CommercePortalAuthVerificationRequest[] = [];
    const client: CommercePortalAuthVerificationClientPort = {
      verify: (request) => {
        calls.push(request);
        return Effect.succeed(makeAllowedResult(request));
      },
    };
    const service = makeCommerceAdmissionObservationService(client, configuration);
    const request: AuthenticationAdmissionRequest = {
      audience: providerEndpointAudience,
      authBindingId,
      authContextRef: sessionRef,
      authenticationNamespaceId: namespaceId,
      nonce: '20000000-0000-4000-8000-000000000002',
      operationRef: 'commerce-operation-02',
      principalId: boundPrincipalId,
      subjectType: 'user',
      tenantId,
    };
    const observation = yield* service.observeAuthentication(request).pipe(
      Effect.provideService(ExternalIdentityHttpWorkloadContext, {
        authenticationRef: sessionRef,
        binding: {
          authBindingId,
          bindingRevision: 7,
          principalId: boundPrincipalId,
        },
        operation: 'resolve',
        principal: workloadPrincipal,
        providerSubjectId,
        targetAuthenticationNamespaceId: namespaceId,
      }),
    );

    expect(calls[0]).toMatchObject({
      audience: providerEndpointAudience,
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      providerSubjectId,
      sessionRef,
      tenantId,
    });
    expect(observation).toMatchObject({
      authBindingId,
      authenticationNamespaceId: namespaceId,
      bindingRevision: 7,
      principalId: boundPrincipalId,
      tenantId,
    });
    expect(Schema.is(AuthenticationAdmissionObservationSchema)(observation)).toBe(true);
  }),
);

it.effect('sends the Commerce receiving audience while preserving a downstream gateway audience', () =>
  Effect.gen(function* commerceGatewayObservation() {
    const calls: CommercePortalAuthVerificationRequest[] = [];
    const client: CommercePortalAuthVerificationClientPort = {
      verify: (request) => {
        calls.push(request);
        return Effect.succeed(makeAllowedResult(request));
      },
    };
    const service = makeCommerceAdmissionObservationService(client, configuration);
    const request: AuthenticationAdmissionRequest = {
      audience: gatewayAudience,
      authBindingId,
      authContextRef: sessionRef,
      authenticationNamespaceId: namespaceId,
      nonce: '20000000-0000-4000-8000-000000000003',
      operationRef: 'commerce-operation-03',
      principalId: boundPrincipalId,
      subjectType: 'user',
      tenantId,
    };
    const observation = yield* service
      .observeAuthentication(request)
      .pipe(Effect.provideService(ExternalIdentityHttpWorkloadContext, makeContext()));

    expect(calls[0]).toMatchObject({
      audience: providerEndpointAudience,
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      providerSubjectId,
      sessionRef,
      tenantId,
    });
    expect(observation).toMatchObject({ audience: gatewayAudience, bindingRevision: 7 });
  }),
);

it.effect('routes the production deployment client to the Commerce API prefix', () =>
  Effect.gen(function* productionDeploymentClient() {
    const outboundUrls: string[] = [];
    const outboundAssertions: string[] = [];
    const workloadAuthorization: ExternalIdentityWorkloadAuthorizationService = {
      authenticate: () => Effect.succeed(workloadPrincipal),
      authorize: () => Effect.succeed(workloadPrincipal),
      authorizePrincipal: (principal, input) => {
        expect(input).toEqual({ operation: 'reserve', targetAuthenticationNamespaceId: namespaceId });
        return Effect.succeed(principal);
      },
    };
    const issuer: GatewayIssuer['Service'] = {
      issue: <Principal>({ audience, principal }: { audience: string; principal: Principal }) => {
        expect(audience).toBe(providerEndpointAudience);
        expect(principal).toBe(workloadPrincipal);
        return Effect.succeed({ expiresAt: nowMillis + 30_000, token: 'commerce-workload-token' });
      },
    };
    const fakeFetch: typeof fetch = async (input, init) => {
      const outboundRequest = new Request(input, init);
      outboundUrls.push(outboundRequest.url);
      outboundAssertions.push(outboundRequest.headers.get('authorization') ?? '');
      const rawBody = await outboundRequest.text();
      const request = Schema.decodeUnknownSync(CommercePortalAuthVerificationRequestSchema)(
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(rawBody),
      );
      return Response.json(makeAllowedResult(request), { status: 200 });
    };
    const match = {
      audience: providerEndpointAudience,
      authContextRef: sessionRef,
      authenticationNamespaceId: namespaceId,
      nonce: '20000000-0000-4000-8000-000000000004',
      operationRef: 'commerce-operation-04',
      providerSubjectId: decode(ProviderSubjectIdSchema, providerSubjectId),
      subjectType: 'user' as const,
      tenantId,
    };
    const run = Effect.gen(function* runProductionDeployment() {
      const service = yield* TrustedExternalSubjectAdmissionService;
      return yield* provideExternalIdentityHttpWorkload(
        {
          authenticationRef: sessionRef,
          operation: 'reserve',
          principal: workloadPrincipal,
          providerSubjectId,
          targetAuthenticationNamespaceId: namespaceId,
        },
        service.admit(match),
      );
    }).pipe(
      Effect.provide(commerceExternalIdentityDeploymentLayer(rawConfiguration)),
      Effect.provide(
        Layer.succeed(AuthenticationNamespaceRegistry, makeCommerceAuthenticationNamespaceRegistry(configuration)),
      ),
      Effect.provideService(ExternalIdentityWorkloadAuthorization, workloadAuthorization),
      Effect.provideService(GatewayIssuer, issuer),
      Effect.provideService(Clock.Clock, fixedClock),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    );
    yield* run;

    expect(outboundUrls).toEqual([
      'https://commerce.example.test/commerce-customer-context-api/portal-auth/internal/verify',
    ]);
    expect(outboundAssertions).toEqual(['Bearer commerce-workload-token']);
  }),
);
