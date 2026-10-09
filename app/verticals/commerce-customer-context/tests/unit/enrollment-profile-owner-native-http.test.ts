import { CommerceEnrollmentOwnerEffectUnavailable } from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import { GatewayContextRequestSchema } from '@app/shared-contracts';
import { ConfigProvider, DateTime, Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { EnsureRetailCustomerProfilePayloadSchema } from '../../shared/actions/ensure-retail-customer-profile.ts';
import { BindRetailPortalProfilePayloadSchema } from '../../shared/actions/bind-retail-portal-profile.ts';
import {
  RetailPortalPermissionCodeSchema,
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
} from '../../shared/domain/profile-contracts.ts';
import {
  retailCustomerProfileActionExecutor,
  retailPortalBindingActionExecutor,
} from '../../src/enrollment/journeys/retail-self-enrollment-profile-owners.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const revision = 'a'.repeat(64);
const servicePrincipalId = '40000000-0000-4000-8000-000000000001';
const issuedAssertion = (mode: string): string => {
  const claims = {
    aud: 'commerce-customer-context',
    compositionRevision: mode === 'wrong-assertion-revision' ? 'b'.repeat(64) : revision,
    exp: 1_800_000_300,
    iat: 1_800_000_000,
    iss: 'trusted-shell',
    jti: '50000000-0000-4000-8000-000000000001',
    principal: {
      authBindingId: '60000000-0000-4000-8000-000000000001',
      authContextRef: 'api-key:enrollment-service',
      authMethod: 'api_key',
      legalEntityId: mode === 'wrong-legal-entity' ? '70000000-0000-4000-8000-000000000001' : legalEntityId,
      principalId: servicePrincipalId,
      tenantId: mode === 'wrong-tenant' ? '80000000-0000-4000-8000-000000000001' : tenantId,
    },
    sub: servicePrincipalId,
    targetBuildMarker: 'approved-owner-build',
    ver: 1,
  };
  return `${Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'test-key', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.issuer-signature`;
};
const requestCorrelation = 'scheduled-retail-owner-proof';
const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'party-1',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const principalRef = {
  moduleId: 'core.identity',
  resourceId: principalId,
  resourceType: 'core.identity.principal',
  tenantId,
} as const;
const effectiveAt = DateTime.makeUnsafe('2026-10-02T17:00:00.000Z');
const profileInput = {
  compositionRevision: revision,
  effectiveAt,
  partyRef,
  requestCorrelation,
  sellingLegalEntityRef,
};
const bindingInput = {
  compositionRevision: revision,
  effectiveAt,
  enrollmentEvidenceRef: 'attempt-1',
  principalRef,
  profileRef,
  reason: 'Retail enrollment',
  requestCorrelation,
  sellingLegalEntityRef,
};
const profilePayload = Schema.decodeSync(EnsureRetailCustomerProfilePayloadSchema)({
  effectiveAt: DateTime.formatIso(effectiveAt),
  subject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef },
  trigger: 'AUTHORIZED_ONBOARDING',
});
const bindingPayload = Schema.decodeSync(BindRetailPortalProfilePayloadSchema)({
  effectiveAt: DateTime.formatIso(effectiveAt),
  enrollmentEvidenceRef: 'attempt-1',
  expectedRevision: null,
  expectedState: null,
  principalRef,
  profileRef,
  reason: 'Retail enrollment',
  sellingLegalEntityRef,
});

const NativeRequestPayloadSchema = Schema.Union([
  GatewayContextRequestSchema,
  EnsureRetailCustomerProfilePayloadSchema,
  BindRetailPortalProfilePayloadSchema,
]);

const bindingResponse = {
  authorizationOperation: 'grant',
  authorizationState: 'PENDING_GRANT',
  bindingRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'binding-1',
    resourceType: 'commerce.customer-context.retail-portal-profile-binding',
    tenantId,
  },
  effectiveAt: DateTime.formatIso(effectiveAt),
  outcome: 'BINDING_ACTIVATED',
  permissionMutations: RETAIL_PORTAL_SELF_SERVICE_BASELINE.map((permission, index) => ({
    mutationId: `9000000${String(index)}-0000-4000-8000-000000000001`,
    operation: 'grant',
    permission: Schema.decodeSync(RetailPortalPermissionCodeSchema)(permission),
    staged: true,
  })),
  revision: 1,
  state: 'ACTIVE',
};
interface CapturedRequest {
  readonly headers: Headers;
  readonly path: string;
  readonly payload: unknown;
}

const IssuanceModeSchema = Schema.Literals([
  'current',
  'stale',
  'mismatched',
  'wrong-tenant',
  'wrong-legal-entity',
  'wrong-assertion-revision',
]);
type IssuanceMode = typeof IssuanceModeSchema.Type;

const nativeOwnerServer = (mode: IssuanceMode) =>
  Effect.sync(() => {
    const requests: CapturedRequest[] = [];
    const nativeFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      return request.text().then((text) => {
        const payload = Schema.decodeSync(Schema.fromJsonString(NativeRequestPayloadSchema))(text);
        requests.push({ headers: request.headers, path, payload });
        if (path.endsWith('/auth/api-key/gateway-context')) {
          return mode === 'stale'
            ? Response.json(
                {
                  detail: 'The enrollment release is no longer admitted',
                  reloadRequired: true,
                  status: 409,
                  title: 'Reload required',
                  type: 'https://ontos.dev/problems/gateway-reload-required',
                },
                { status: 409 },
              )
            : Response.json({
                apiBaseUrl: '/selected-owner-api',
                compositionRevision: mode === 'mismatched' ? 'b'.repeat(64) : revision,
                expiresAt: 1_800_000_300,
                token: issuedAssertion(mode),
              });
        }
        if (path.endsWith('/ensure-retail-customer-profile')) {
          return Response.json({ outcome: 'PROFILE_CREATED', profileRef, revision: 1, state: 'ACTIVE' });
        }
        return Response.json(bindingResponse);
      });
    };
    return { baseUrl: new URL('https://shell.example.test/shell-super-app-api'), nativeFetch, requests };
  });

const configured = (baseUrl: URL) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: 'reviewed-enrollment-service-key',
      ONTOS_SHELL_GATEWAY_BASE_URL: baseUrl.href,
    }),
  );

it.effect('dispatches scheduled profile and portal owners over native HTTP without a browser Document', () =>
  Effect.gen(function* nativeScheduledDispatch() {
    expect(globalThis).not.toHaveProperty('document');
    const server = yield* nativeOwnerServer('current');
    yield* retailCustomerProfileActionExecutor(profileInput)(profilePayload, requestCorrelation, {
      idempotencyKey: 'profile-invocation',
    }).pipe(
      Effect.provide(configured(server.baseUrl)),
      Effect.provideService(FetchHttpClient.Fetch, server.nativeFetch),
    );
    yield* retailPortalBindingActionExecutor(bindingInput)(bindingPayload, requestCorrelation, {
      idempotencyKey: 'binding-invocation',
    }).pipe(
      Effect.provide(configured(server.baseUrl)),
      Effect.provideService(FetchHttpClient.Fetch, server.nativeFetch),
    );
    expect(server.requests).toHaveLength(4);
    const issuance = server.requests.filter(({ path }) => path.endsWith('/gateway-context'));
    expect(issuance.map(({ payload }) => payload)).toEqual([
      { audience: 'commerce-customer-context', compositionRevision: revision, legalEntityId },
      { audience: 'commerce-customer-context', compositionRevision: revision, legalEntityId },
    ]);
    expect(issuance.every(({ headers }) => headers.get('x-api-key') === 'reviewed-enrollment-service-key')).toBe(true);
    const owners = server.requests.filter(({ path }) => path.startsWith('/selected-owner-api'));
    expect(owners.map(({ path }) => path)).toEqual([
      '/selected-owner-api/commerce-customer-context/actions/ensure-retail-customer-profile',
      '/selected-owner-api/commerce-customer-context/actions/bind-retail-portal-profile',
    ]);
    expect(
      owners.every(
        ({ headers }) =>
          headers.get('authorization') === `Bearer ${issuedAssertion('current')}` &&
          headers.get('x-ontos-composition-revision') === revision &&
          headers.get('x-correlation-id') === requestCorrelation &&
          headers.get('x-api-key') === null,
      ),
    ).toBe(true);
    expect(owners.map(({ headers }) => headers.get('idempotency-key'))).toEqual([
      'profile-invocation',
      'binding-invocation',
    ]);
    expect(owners.map(({ payload }) => payload)).toEqual([profilePayload, bindingPayload]);
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
);

for (const mode of ['stale', 'mismatched', 'wrong-tenant', 'wrong-legal-entity', 'wrong-assertion-revision'] as const) {
  it.effect(`rejects ${mode} enrollment composition before contacting either business owner`, () =>
    Effect.gen(function* rejectedScheduledDispatch() {
      const server = yield* nativeOwnerServer(mode);
      const profileFailure = yield* retailCustomerProfileActionExecutor(profileInput)(
        profilePayload,
        requestCorrelation,
        { idempotencyKey: 'profile-invocation' },
      ).pipe(
        Effect.provide(configured(server.baseUrl)),
        Effect.provideService(FetchHttpClient.Fetch, server.nativeFetch),
        Effect.flip,
      );
      const bindingFailure = yield* retailPortalBindingActionExecutor(bindingInput)(
        bindingPayload,
        requestCorrelation,
        { idempotencyKey: 'binding-invocation' },
      ).pipe(
        Effect.provide(configured(server.baseUrl)),
        Effect.provideService(FetchHttpClient.Fetch, server.nativeFetch),
        Effect.flip,
      );
      expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(profileFailure)).toBe(true);
      expect(Schema.is(CommerceEnrollmentOwnerEffectUnavailable)(bindingFailure)).toBe(true);
      expect(server.requests).toHaveLength(2);
      expect(server.requests.every(({ path }) => path.endsWith('/gateway-context'))).toBe(true);
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
  );
}

it.effect('pins enrollment revision, tenant, Legal Entity and correlation before a caller can mutate its input', () =>
  Effect.gen(function* pinnedScheduledAuthority() {
    const server = yield* nativeOwnerServer('current');
    const mutableInput = {
      ...profileInput,
      partyRef: { ...partyRef },
      sellingLegalEntityRef: { ...sellingLegalEntityRef },
    };
    const execute = retailCustomerProfileActionExecutor(mutableInput);
    mutableInput.compositionRevision = 'b'.repeat(64);
    mutableInput.requestCorrelation = 'mutated-correlation';
    Object.assign(mutableInput.partyRef, { tenantId: '90000000-0000-4000-8000-000000000001' });
    Object.assign(mutableInput.sellingLegalEntityRef, { resourceId: '70000000-0000-4000-8000-000000000001' });
    yield* execute(profilePayload, 'mutated-correlation', { idempotencyKey: 'profile-invocation' }).pipe(
      Effect.provide(configured(server.baseUrl)),
      Effect.provideService(FetchHttpClient.Fetch, server.nativeFetch),
    );
    expect(server.requests[0]?.payload).toEqual({
      audience: 'commerce-customer-context',
      compositionRevision: revision,
      legalEntityId,
    });
    expect(server.requests[1]?.headers.get('x-ontos-composition-revision')).toBe(revision);
    expect(server.requests[1]?.headers.get('x-correlation-id')).toBe(requestCorrelation);
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped),
);
