import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { AuthenticationAdmissionRequest } from '@app/core-runtime/auth/external-identity-admission';
import {
  AuthenticationNamespaceRegistry,
  TrustedAdmissionObservation,
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
  ExternalIdentityVerificationRequestSchema,
  ExternalIdentityVerificationResultSchema,
  OntosExternalIdentityProviderSchema,
} from '@app/core-runtime/auth/external-identity-provider';
import type {
  ExternalIdentityVerificationRequest,
  ExternalIdentityVerificationResult,
  OntosExternalIdentityProviderInput,
} from '@app/core-runtime/auth/external-identity-provider';
import { Clock, DateTime, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import { makeExternalIdentityProviderDeployment } from '../../api/auth/external-identity-provider-deployment.ts';
import {
  ExternalIdentityProviderConfigurationSchema,
  ExternalIdentityProviderConfigurationService,
  externalIdentityProviderRegistrationOf,
} from '../../api/auth/external-identity-provider.ts';
import { ExternalIdentityProviderNamespaceRegistryLive } from '../../api/auth/external-identity/provider-admission.ts';
import { InstalledExternalIdentityProviderResolverLive } from '../../api/auth/external-identity/provider-resolver.ts';
import type { InstalledExternalIdentityProvider } from '../../api/auth/external-identity-provider.ts';
import { ProviderAdmissionObservationLive } from '../../api/auth/external-identity/provider-admission-observation.ts';
import {
  acquireExternalIdentityWorkloadAssertion,
  ExternalIdentityVerificationClient,
} from '../../api/auth/external-identity/provider-verification-client.ts';
import type { ExternalIdentityVerificationClientService } from '../../api/auth/external-identity/provider-verification-client.ts';
import { ExternalIdentityWorkloadAuthorization } from '../../api/auth/external-identity/workload-authorization.ts';
import type { ExternalIdentityWorkloadAuthorizationService } from '../../api/auth/external-identity/workload-authorization.ts';
import {
  ExternalIdentityHttpWorkloadContext,
  provideExternalIdentityHttpWorkload,
} from '../../api/auth/external-identity/request-context.ts';
import type { ExternalIdentityHttpWorkloadContextValue } from '../../api/auth/external-identity/request-context.ts';
import { GatewayIssuer, GatewayIssuerError } from '../../api/auth/gateway-issuer.ts';
import { ShellInstalledModuleCatalog } from '../../api/modules/installed-module-catalog.ts';
import type {
  ShellInstalledCatalog,
  ShellInstalledModuleCatalogService,
} from '../../api/modules/installed-module-catalog.ts';

const PROVIDER_NAMESPACE = 'ontos.example.portal.v1';
const PROVIDER_APP_ID = 'example-portal';
const PROVIDER_RELEASE_ORIGIN = 'https://ontos-provider-release.example.workers.dev/';
const declaration = {
  admissionDeadlineMs: 5000,
  authenticationNamespaceId: PROVIDER_NAMESPACE,
  provider: 'example-provider',
  verification: { operation: 'example-portal.verify.v1', path: '/portal/internal/verify' },
} as const satisfies OntosExternalIdentityProviderInput;

/** A composition with one module whose contract declares `providers`. */
const catalogDeclaring = (
  providers: readonly OntosExternalIdentityProviderInput[],
): ShellInstalledModuleCatalogService => ({
  load: Effect.succeed(
    // SAFETY: test double; the provider resolution reads only `composition.modules[].{backend.baseUrl,deployment.appId,contractDocument}`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Test double of the installed catalog.
    {
      composition: {
        modules: [
          {
            backend: { baseUrl: PROVIDER_RELEASE_ORIGIN },
            contractDocument: JSON.stringify({ manifest: { publicSurface: { externalIdentityProviders: providers } } }),
            deployment: { appId: PROVIDER_APP_ID },
            moduleId: 'example.portal',
          },
        ],
      },
    } as unknown as ShellInstalledCatalog,
  ),
});
const catalog = catalogDeclaring([declaration]);
const installed: InstalledExternalIdentityProvider = {
  appId: PROVIDER_APP_ID,
  backendBaseUrl: PROVIDER_RELEASE_ORIGIN,
  declaration: Schema.decodeUnknownSync(OntosExternalIdentityProviderSchema)(declaration),
};

const decode = <S extends Schema.ConstraintDecoder<unknown>, Value>(schema: S, input: Value): S['Type'] =>
  Schema.decodeUnknownSync(schema)(input);

const namespaceId = decode(AuthenticationNamespaceIdSchema, PROVIDER_NAMESPACE);
const workloadNamespaceId = decode(AuthenticationNamespaceIdSchema, 'ontos.staff.gateway-api-key.v1');
const tenantId = decode(TenantIdSchema, '10000000-0000-4000-8000-000000000001');
const workloadPrincipalId = decode(PrincipalIdSchema, '10000000-0000-4000-8000-000000000002');
const authBindingId = decode(AuthBindingIdSchema, '10000000-0000-4000-8000-000000000003');
const boundPrincipalId = decode(PrincipalIdSchema, '10000000-0000-4000-8000-000000000004');
const attesterPrincipalId = decode(PrincipalIdSchema, '10000000-0000-4000-8000-000000000005');
const providerSubjectId = 'portal-user-01';
const sessionRef = `portal-session:${PROVIDER_NAMESPACE}:session-01`;
const providerEndpointAudience = PROVIDER_APP_ID;
const gatewayAudience = 'party-registry';
const compositionRevision = 'a'.repeat(64);
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
  authenticationNamespaceId: PROVIDER_NAMESPACE,
  grants: [
    {
      operation: 'resolve',
      receivingAudience: providerEndpointAudience,
      targetAuthenticationNamespaceId: PROVIDER_NAMESPACE,
      tenantId,
      workloadAuthenticationNamespaceId: workloadNamespaceId,
      workloadPrincipalId,
    },
    {
      operation: 'gateway-context',
      receivingAudience: providerEndpointAudience,
      targetAudience: gatewayAudience,
      targetAuthenticationNamespaceId: PROVIDER_NAMESPACE,
      tenantId,
      workloadAuthenticationNamespaceId: workloadNamespaceId,
      workloadPrincipalId,
    },
  ],
  providerEndpointAudience,
};
const configuration = decode(ExternalIdentityProviderConfigurationSchema, rawConfiguration);

/** Configuration plus the provider resolver over `catalogService`. */
const providerBase = (catalogService: ShellInstalledModuleCatalogService) => {
  const configurationLive = Layer.succeed(ExternalIdentityProviderConfigurationService, configuration);
  return Layer.merge(
    configurationLive,
    InstalledExternalIdentityProviderResolverLive.pipe(
      Layer.provide(Layer.merge(configurationLive, Layer.succeed(ShellInstalledModuleCatalog, catalogService))),
    ),
  );
};

const lookupWith = (
  catalogService: ShellInstalledModuleCatalogService,
  id: Schema.Schema.Type<typeof AuthenticationNamespaceIdSchema>,
) =>
  AuthenticationNamespaceRegistry.pipe(
    Effect.flatMap((registry) => registry.lookup(id)),
    Effect.provide(ExternalIdentityProviderNamespaceRegistryLive.pipe(Layer.provide(providerBase(catalogService)))),
  );

const workloadPrincipal = decode(TrustedPrincipalContextSchema, {
  authBindingId: '10000000-0000-4000-8000-000000000006',
  authContextRef: 'api-key:provider-workload-01',
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
  compositionRevision,
  operation: 'gateway-context' as const,
  principal: workloadPrincipal,
  providerSubjectId,
  targetAudience: gatewayAudience,
  targetAuthenticationNamespaceId: namespaceId,
  ...overrides,
});

/**
 * The audience a verification request actually carries is the one the provider *receives* it on —
 * `makeProviderRequest` in `external-identity/provider-admission-observation.ts` always builds it
 * with `providerEndpointAudience`, and the gateway assertion is minted for that same audience.
 * A downstream `targetAudience` never reaches this field.
 */
const makeProviderRequest = (audience = providerEndpointAudience): ExternalIdentityVerificationRequest =>
  decode(ExternalIdentityVerificationRequestSchema, {
    audience,
    authenticationNamespaceId: namespaceId,
    nonce: '20000000-0000-4000-8000-000000000001',
    operation: declaration.verification.operation,
    operationRef: 'provider-operation-01',
    providerSubjectId,
    sessionRef,
    subjectType: 'user',
    tenantId,
  });

const makeAllowedResult = (request: ExternalIdentityVerificationRequest): ExternalIdentityVerificationResult =>
  decode(ExternalIdentityVerificationResultSchema, {
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

it.effect('registers provider audiences from the explicit endpoint and gateway grants', () =>
  Effect.sync(() => {
    const registration = externalIdentityProviderRegistrationOf(configuration, installed.declaration);
    expect(registration.provider).toBe(declaration.provider);
    expect(registration.authenticationNamespaceId).toBe(namespaceId);
    expect(registration.allowedAudiences).toEqual([providerEndpointAudience, gatewayAudience]);
    expect(registration.trustedAttesterPrincipalIds).toEqual([attesterPrincipalId]);
    expect(registration.subjectTypes).toEqual(['user']);
  }),
);

it.effect('mints a fresh provider audience assertion for every exact workload call', () =>
  Effect.gen(function* freshWorkloadAssertion() {
    const authorizationCalls: { operation: string; targetAudience?: string }[] = [];
    const issueCalls: { audience: string; compositionRevision: string; principal: unknown }[] = [];
    const authorization: ExternalIdentityWorkloadAuthorizationService = {
      authenticate: () => Effect.succeed(workloadPrincipal),
      authorize: () => Effect.succeed(workloadPrincipal),
      authorizePrincipal: (principal, input) => {
        authorizationCalls.push(input);
        return Effect.succeed(principal);
      },
    };
    const issuer: GatewayIssuer['Service'] = {
      forgetAuthContext: () => Effect.void,
      issue: ({ audience, compositionRevision: revision, principal }) => {
        issueCalls.push({ audience, compositionRevision: revision, principal });
        return Effect.succeed({
          apiBaseUrl: '/shell-super-app-api/module-api/example-portal/test-build/example-portal-api',
          compositionRevision: revision,
          expiresAt: 300,
          token: `provider-workload-token-${issueCalls.length}`,
        });
      },
    };
    const request = makeProviderRequest();
    const acquire = Effect.gen(function* acquireAssertion() {
      const first = yield* acquireExternalIdentityWorkloadAssertion(configuration, request);
      const second = yield* acquireExternalIdentityWorkloadAssertion(configuration, request);
      return { first, second };
    }).pipe(
      Effect.provideService(ExternalIdentityWorkloadAuthorization, authorization),
      Effect.provideService(GatewayIssuer, issuer),
      Effect.provideService(ExternalIdentityHttpWorkloadContext, makeContext()),
    );
    const { first, second } = yield* acquire;

    expect(Redacted.value(first)).toBe('Bearer provider-workload-token-1');
    expect(Redacted.value(second)).toBe('Bearer provider-workload-token-2');
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
    expect(issueCalls[0]).toEqual({
      audience: providerEndpointAudience,
      compositionRevision,
      principal: workloadPrincipal,
    });
    expect(issueCalls[1]).toEqual({
      audience: providerEndpointAudience,
      compositionRevision,
      principal: workloadPrincipal,
    });
  }),
);

/**
 * A `gateway-context` call names a downstream audience the grant keeps distinct from the provider
 * endpoint's own. The assertion is nevertheless minted for — and the request received on — the
 * provider endpoint audience, so that is the only audience this guard may compare. Comparing the
 * downstream target instead closed every gateway-context call as `identity_unavailable`.
 */
it.effect('admits a gateway-context assertion audienced for the provider verification endpoint', () =>
  Effect.gen(function* gatewayContextAssertionAudience() {
    const issueCalls: { audience: string; compositionRevision: string; principal: unknown }[] = [];
    const authorization: ExternalIdentityWorkloadAuthorizationService = {
      authenticate: () => Effect.succeed(workloadPrincipal),
      authorize: () => Effect.succeed(workloadPrincipal),
      authorizePrincipal: (principal) => Effect.succeed(principal),
    };
    const issuer: GatewayIssuer['Service'] = {
      forgetAuthContext: () => Effect.void,
      issue: ({ audience, compositionRevision: revision, principal }) => {
        issueCalls.push({ audience, compositionRevision: revision, principal });
        return Effect.succeed({
          apiBaseUrl: '/shell-super-app-api/module-api/example-portal/test-build/example-portal-api',
          compositionRevision: revision,
          expiresAt: 300,
          token: `provider-gateway-token-${issueCalls.length}`,
        });
      },
    };
    const acquireFor = (request: ExternalIdentityVerificationRequest) =>
      acquireExternalIdentityWorkloadAssertion(configuration, request).pipe(
        Effect.provideService(ExternalIdentityWorkloadAuthorization, authorization),
        Effect.provideService(GatewayIssuer, issuer),
        // `targetAudience` is the downstream gateway audience the grant declares.
        Effect.provideService(ExternalIdentityHttpWorkloadContext, makeContext()),
      );

    const admitted = yield* acquireFor(makeProviderRequest(providerEndpointAudience));
    expect(Redacted.value(admitted)).toBe('Bearer provider-gateway-token-1');
    expect(issueCalls).toEqual([
      { audience: providerEndpointAudience, compositionRevision, principal: workloadPrincipal },
    ]);

    // An assertion minted for any other audience is still refused: the guard is a real check.
    const refused = yield* Effect.result(acquireFor(makeProviderRequest(gatewayAudience)));
    expect(Result.isFailure(refused)).toBe(true);
    if (Result.isFailure(refused)) {
      expect(refused.failure.reason).toBe('The external identity receiving audience changed during admission');
    }
    expect(issueCalls).toHaveLength(1);
  }),
);

it.effect('refuses a provider workload assertion when its captured composition revision is no longer approved', () =>
  Effect.gen(function* staleCompositionAssertion() {
    const staleRevision = 'b'.repeat(64);
    const issueRevisions: string[] = [];
    const authorization: ExternalIdentityWorkloadAuthorizationService = {
      authenticate: () => Effect.succeed(workloadPrincipal),
      authorize: () => Effect.succeed(workloadPrincipal),
      authorizePrincipal: (principal) => Effect.succeed(principal),
    };
    const issuer: GatewayIssuer['Service'] = {
      forgetAuthContext: () => Effect.void,
      issue: (input) => {
        issueRevisions.push(input.compositionRevision);
        return Effect.fail(
          new GatewayIssuerError({
            code: 'gateway_revision_unsupported',
            reason: 'The requested composition revision is no longer approved',
            stage: 'audience',
          }),
        );
      },
    };
    const result = yield* acquireExternalIdentityWorkloadAssertion(configuration, makeProviderRequest()).pipe(
      Effect.provideService(ExternalIdentityWorkloadAuthorization, authorization),
      Effect.provideService(GatewayIssuer, issuer),
      Effect.provideService(ExternalIdentityHttpWorkloadContext, makeContext({ compositionRevision: staleRevision })),
      Effect.result,
    );

    expect(issueRevisions).toEqual([staleRevision]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe('The Shell workload is not authorized to call provider verification');
    }
  }),
);

it.effect('projects an ALLOWED provider response into a binding revision bound to the request context', () =>
  Effect.gen(function* providerObservation() {
    const calls: ExternalIdentityVerificationRequest[] = [];
    const client: ExternalIdentityVerificationClientService = {
      verify: (_installed, request) => {
        calls.push(request);
        return Effect.succeed(makeAllowedResult(request));
      },
    };
    const service = yield* TrustedAdmissionObservation.pipe(
      Effect.provide(
        ProviderAdmissionObservationLive.pipe(
          Layer.provide(Layer.merge(providerBase(catalog), Layer.succeed(ExternalIdentityVerificationClient, client))),
        ),
      ),
    );
    const request: AuthenticationAdmissionRequest = {
      audience: providerEndpointAudience,
      authBindingId,
      authContextRef: sessionRef,
      authenticationNamespaceId: namespaceId,
      nonce: '20000000-0000-4000-8000-000000000002',
      operationRef: 'provider-operation-02',
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
        compositionRevision,
        operation: 'resolve',
        principal: workloadPrincipal,
        providerSubjectId,
        targetAuthenticationNamespaceId: namespaceId,
      }),
    );

    expect(calls[0]).toMatchObject({
      audience: providerEndpointAudience,
      authenticationNamespaceId: PROVIDER_NAMESPACE,
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

it.effect('sends the provider receiving audience while preserving a downstream gateway audience', () =>
  Effect.gen(function* providerGatewayObservation() {
    const calls: ExternalIdentityVerificationRequest[] = [];
    const client: ExternalIdentityVerificationClientService = {
      verify: (_installed, request) => {
        calls.push(request);
        return Effect.succeed(makeAllowedResult(request));
      },
    };
    const service = yield* TrustedAdmissionObservation.pipe(
      Effect.provide(
        ProviderAdmissionObservationLive.pipe(
          Layer.provide(Layer.merge(providerBase(catalog), Layer.succeed(ExternalIdentityVerificationClient, client))),
        ),
      ),
    );
    const request: AuthenticationAdmissionRequest = {
      audience: gatewayAudience,
      authBindingId,
      authContextRef: sessionRef,
      authenticationNamespaceId: namespaceId,
      nonce: '20000000-0000-4000-8000-000000000003',
      operationRef: 'provider-operation-03',
      principalId: boundPrincipalId,
      subjectType: 'user',
      tenantId,
    };
    const observation = yield* service
      .observeAuthentication(request)
      .pipe(Effect.provideService(ExternalIdentityHttpWorkloadContext, makeContext()));

    expect(calls[0]).toMatchObject({
      audience: providerEndpointAudience,
      authenticationNamespaceId: PROVIDER_NAMESPACE,
      providerSubjectId,
      sessionRef,
      tenantId,
    });
    expect(observation).toMatchObject({ audience: gatewayAudience, bindingRevision: 7 });
  }),
);

it.effect('routes the production deployment client to the verification path the provider module declares', () =>
  Effect.gen(function* productionDeploymentClient() {
    const outboundUrls: string[] = [];
    const outboundAssertions: string[] = [];
    const outboundOperations: string[] = [];
    const workloadAuthorization: ExternalIdentityWorkloadAuthorizationService = {
      authenticate: () => Effect.succeed(workloadPrincipal),
      authorize: () => Effect.succeed(workloadPrincipal),
      authorizePrincipal: (principal, input) => {
        expect(input).toEqual({ operation: 'reserve', targetAuthenticationNamespaceId: namespaceId });
        return Effect.succeed(principal);
      },
    };
    const issuer: GatewayIssuer['Service'] = {
      forgetAuthContext: () => Effect.void,
      issue: ({ audience, compositionRevision: revision, principal }) => {
        expect(audience).toBe(providerEndpointAudience);
        expect(revision).toBe(compositionRevision);
        expect(principal).toBe(workloadPrincipal);
        return Effect.succeed({
          apiBaseUrl: '/shell-super-app-api/module-api/example-portal/test-build/example-portal-api',
          compositionRevision: revision,
          expiresAt: nowMillis + 30_000,
          token: 'provider-workload-token',
        });
      },
    };
    const fakeFetch: typeof fetch = async (input, init) => {
      const outboundRequest = new Request(input, init);
      outboundUrls.push(outboundRequest.url);
      outboundAssertions.push(outboundRequest.headers.get('authorization') ?? '');
      const rawBody = await outboundRequest.text();
      const request = Schema.decodeUnknownSync(ExternalIdentityVerificationRequestSchema)(
        Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(rawBody),
      );
      outboundOperations.push(request.operation);
      return Response.json(makeAllowedResult(request), { status: 200 });
    };
    const match = {
      audience: providerEndpointAudience,
      authContextRef: sessionRef,
      authenticationNamespaceId: namespaceId,
      nonce: '20000000-0000-4000-8000-000000000004',
      operationRef: 'provider-operation-04',
      providerSubjectId: decode(ProviderSubjectIdSchema, providerSubjectId),
      subjectType: 'user' as const,
      tenantId,
    };
    const run = Effect.gen(function* runProductionDeployment() {
      const service = yield* TrustedExternalSubjectAdmissionService;
      return yield* provideExternalIdentityHttpWorkload(
        {
          authenticationRef: sessionRef,
          compositionRevision,
          operation: 'reserve',
          principal: workloadPrincipal,
          providerSubjectId,
          targetAuthenticationNamespaceId: namespaceId,
        },
        service.admit(match),
      );
    }).pipe(
      Effect.provide(makeExternalIdentityProviderDeployment(rawConfiguration).externalIdentityDeploymentLayer),
      Effect.provide(ExternalIdentityProviderNamespaceRegistryLive.pipe(Layer.provide(providerBase(catalog)))),
      Effect.provideService(ShellInstalledModuleCatalog, catalog),
      Effect.provideService(ExternalIdentityWorkloadAuthorization, workloadAuthorization),
      Effect.provideService(GatewayIssuer, issuer),
      Effect.provideService(Clock.Clock, fixedClock),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    );
    yield* run;

    expect(outboundUrls).toEqual([`${PROVIDER_RELEASE_ORIGIN}example-portal-api/portal/internal/verify`]);
    expect(outboundOperations).toEqual([declaration.verification.operation]);
    expect(outboundAssertions).toEqual(['Bearer provider-workload-token']);
  }),
);

it.effect('registers the configured namespace only while an installed module declares it', () =>
  Effect.gen(function* registryFollowsComposition() {
    const declared = yield* lookupWith(catalog, namespaceId);
    expect(Option.getOrUndefined(declared)?.provider).toBe(declaration.provider);
    const undeclared = yield* lookupWith(catalogDeclaring([]), namespaceId);
    expect(Option.isNone(undeclared)).toBe(true);
    const otherNamespace = yield* lookupWith(catalog, workloadNamespaceId);
    expect(Option.isNone(otherNamespace)).toBe(true);
  }),
);
