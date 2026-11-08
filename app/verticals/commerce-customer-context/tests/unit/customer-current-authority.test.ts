import { randomUUID } from 'node:crypto';

import { GatewayAssertionRedemptionService, ReadRuntime, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { preserveSystemPrincipalContextTrust } from '@app/core-runtime/auth/system-principal-context-provenance';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import { ResolveExternalSubjectResultSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import {
  bindGatewayPrincipalVerifier,
  makeGatewayPrincipalVerifierLayer,
} from '@app/gateway-principal-verifier/server';
import { ExternalIdentityForbiddenProblemSchema } from '@app/shared-contracts/external-identity';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import type {
  ExternalIdentityClientPort,
  ResolveExternalSubjectRequest,
} from '@app/shared-contracts/server/external-identity-client';
import { Clock, ConfigProvider, Crypto, Effect, Layer, PlatformError, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { CommerceAuthenticationNamespaceRegistryLive } from '../../api/portal-auth/authentication-namespace-registry.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { CommerceCoreIdentityClientConfig } from '../../api/portal-auth/provider/core-identity-client-config.ts';
import { makeCommerceTenantWorkloadCredentials } from '../../api/tenant-workload-credentials.ts';
import {
  CommerceCustomerAuthority,
  commerceCustomerAuthorityLive,
  CustomerAuthorityRejected,
  CustomerAuthorityUnavailable,
} from '../../api/portal-auth/session/customer-authority.ts';
import type { CustomerAuthorityInput } from '../../api/portal-auth/session/customer-authority.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import type { EnrollmentAttemptScopedRoutineInvoker } from '../../src/enrollment/attempts/attempt-persistence.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const authBindingId = '40000000-0000-4000-8000-000000000001';
const partyId = '50000000-0000-4000-8000-000000000001';
const profileId = '60000000-0000-4000-8000-000000000001';
const otherId = '70000000-0000-4000-8000-000000000001';
const bindingId = '80000000-0000-4000-8000-000000000001';
const at = '2026-11-07T10:00:00.000Z';
const issuer = 'https://customer-authority-test.invalid';
const input: CustomerAuthorityInput = {
  legalEntityId,
  permission: 'retail.profile.read',
  providerSubjectId: 'provider-owned-subject',
  sessionRef: `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:native-session`,
  tenantId,
};
const unused = () => Effect.die('Unexpected mutation or legacy authority lookup');
const identity = Schema.decodeUnknownSync(ResolveExternalSubjectResultSchema)({
  authBindingId,
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  bindingRevision: 2,
  bindingStatus: 'active',
  outcome: 'RESOLVED',
  principalId,
  tenantId,
});
const actor = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId,
  authContextRef: input.sessionRef,
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
});

interface CustomerAuthorityFixtureState {
  actor: typeof actor;
  authorizationState: string;
  bindingPrincipal: string;
  bindingProfile: string;
  bindingState: string;
  coreDenied: boolean;
  gate: AccessDecision['outcome'];
  identity: typeof identity;
  invalidSignature: boolean;
  malformedBinding: boolean;
  retained: boolean;
  revision: string;
}

const harness = Effect.fnUntraced(function* authorityHarness(
  cryptoLayer: Layer.Layer<Crypto.Crypto> = commercePortalAuthPlatformCryptoLive,
) {
  const snapshot = yield* makeApplicationCompositionSnapshotFixture(
    ['commerce-customer-context'],
    ultramodernApiMarker.buildMarker,
  );
  const pair = yield* Effect.promise(() => generateKeyPair('EdDSA'));
  const jwk = yield* Effect.promise(() => exportJWK(pair.publicKey));
  const environment = {
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...jwk, alg: 'EdDSA', kid: 'customer-test', use: 'sig' }] }),
  };
  const state: CustomerAuthorityFixtureState = {
    actor,
    authorizationState: 'ACTIVE',
    bindingPrincipal: principalId,
    bindingProfile: profileId,
    bindingState: 'ACTIVE',
    coreDenied: false,
    gate: 'ALLOWED',
    identity,
    invalidSignature: false,
    malformedBinding: false,
    retained: true,
    revision: snapshot.composition.revision,
  };
  const sign = () =>
    Effect.gen(function* signAssertion() {
      const epoch = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      return yield* Effect.promise(() =>
        new SignJWT({
          compositionRevision: state.revision,
          principal: state.actor,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: 2,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: 'customer-test', typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience('commerce-customer-context')
          .setSubject(state.actor.principalId)
          .setIssuedAt(epoch)
          .setExpirationTime(epoch + 300)
          .setJti(randomUUID())
          .sign(pair.privateKey),
      );
    });
  const principal = yield* bindGatewayPrincipalVerifier('commerce-customer-context', ultramodernApiMarker)
    .verifyAndRedeem(Redacted.make(`Bearer ${yield* sign()}`), {
      environment,
      redemption: { consume: () => Effect.void },
    })
    .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
  const observedReads: unknown[][] = [];
  const requests: ResolveExternalSubjectRequest[] = [];
  const correlations: string[] = [];
  const gatewayRequests: unknown[] = [];
  const redeemed: string[] = [];
  const gate = makeTestBoundAccessGate({
    get defaultAnswer(): Pick<AccessDecision, 'outcome'> {
      return { outcome: state.gate };
    },
  });
  const runtime = yield* makeReadTestHarness({
    access: 'allowed',
    accessDecision: gate.bound,
    compositionRevision: snapshot.composition.revision,
    databaseIdentities: defineDatabaseIdentityEnrollment([
      {
        moduleKey: 'commerce.customer-context',
        policyPrefix: 'customer_authority_test',
        request: {
          cloudflareHyperdrive: null,
          gatewayScopeAudiences: ['commerce-customer-context'],
          handlesBearerAssertions: true,
          id: 'ccc_authority_test',
          ownerModuleKey: 'commerce.customer-context',
          registersGatewayScopeGrants: false,
          role: 'ccc_authority_test',
          runsActions: false,
          scopeAuthority: 'gateway_grant',
          urlKey: 'CCC_AUTHORITY_TEST_DATABASE_URL',
        },
        schemas: ['commerce_customer_context'],
        worker: {
          cloudflareHyperdrive: null,
          gatewayScopeAudiences: [],
          handlesBearerAssertions: false,
          id: 'ccc_authority_test_worker',
          ownerModuleKey: 'commerce.customer-context',
          registersGatewayScopeGrants: false,
          role: 'ccc_authority_test_worker',
          runsActions: false,
          scopeAuthority: 'session_setting',
          urlKey: 'CCC_AUTHORITY_TEST_WORKER_DATABASE_URL',
        },
      },
    ]),
    executeOwnerQuery: ({ params, sql }) =>
      Effect.gen(function* query() {
        expect(params).toContain(principalId);
        if (sql.includes('resolve_retail_principal')) {
          return [
            { outcome: 'RETAIL_PRINCIPAL_BOUND', payload: { bindingId, observedAt: at, profileId, revision: 1 } },
          ];
        }
        if (sql.includes('read_retail_portal_binding')) {
          return [
            {
              outcome: 'BINDING_AVAILABLE',
              payload: state.malformedBinding
                ? {}
                : {
                    actionInvocationId: '90000000-0000-4000-8000-000000000001',
                    actorPrincipalId: principalId,
                    authorizationOperation: 'grant',
                    authorizationState: state.authorizationState,
                    bindingId,
                    createdAt: at,
                    enrollmentEvidenceRef: 'enrollment-proof',
                    principalId: state.bindingPrincipal,
                    profileId: state.bindingProfile,
                    reason: 'Enrollment',
                    revision: 1,
                    revokedAt: null,
                    state: state.bindingState,
                    updatedAt: at,
                  },
            },
          ];
        }
        return yield* Effect.die(`Unexpected owner SQL: ${sql}`);
      }),
    operationTime: new Date(at),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: commerceCustomerContextRegistration,
    scope: preserveSystemPrincipalContextTrust(principal, { ...principal, correlationId: 'customer-authority-native' }),
  }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive));
  const invoke: EnrollmentAttemptScopedRoutineInvoker['invoke'] = (routine, values) =>
    Effect.sync(() => {
      expect(routine.name).toBe('read_retail_enrollment_account_party');
      observedReads.push([...values]);
      const exact =
        values.at(0) === input.providerSubjectId && values.at(1) === principalId && values.at(2) === authBindingId;
      return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(
        state.retained && exact ? [{ party_id: partyId, profile_id: profileId }] : [],
      );
    });
  const client: ExternalIdentityClientPort = {
    activatePrincipalBinding: unused,
    changePrincipalBindingStatus: unused,
    issueExternalGatewayContext: (request) => {
      gatewayRequests.push(request);
      return state.invalidSignature
        ? Effect.succeed({
            apiBaseUrl: '/commerce-customer-context-api',
            compositionRevision: state.revision,
            expiresAt: 300,
            token: 'not-a-signed-assertion',
          })
        : sign().pipe(
            Effect.map((token) => ({
              apiBaseUrl: '/commerce-customer-context-api',
              compositionRevision: state.revision,
              expiresAt: 300,
              token,
            })),
          );
    },
    readPrincipalBinding: unused,
    reservePrincipalBinding: unused,
    resolveExternalSubject: (request, options) =>
      Effect.suspend(() => {
        requests.push(request);
        if (options?.requestCorrelation !== undefined) {
          correlations.push(options.requestCorrelation);
        }
        return state.coreDenied
          ? Effect.fail(
              Schema.decodeUnknownSync(ExternalIdentityForbiddenProblemSchema)({
                _tag: 'ExternalIdentityForbiddenProblem',
                detail: 'Current identity refused',
                status: 403,
                title: 'Forbidden',
                type: 'https://ontos.dev/problems/external-identity-forbidden',
              }),
            )
          : Effect.succeed(state.identity);
      }),
  };
  const dependencies = Layer.mergeAll(
    cryptoLayer,
    CommerceAuthenticationNamespaceRegistryLive,
    makeGatewayPrincipalVerifierLayer(ConfigProvider.fromUnknown(environment)),
    Layer.succeed(GatewayAssertionRedemptionService, {
      consume: ({ jti }) =>
        Effect.sync(() => {
          redeemed.push(jti);
        }),
    }),
    Layer.succeed(ReadRuntime, runtime.runtime),
    Layer.succeed(ExternalIdentityClient, client),
    Layer.succeed(CommerceCoreIdentityClientConfig, {
      baseUrl: 'https://core.example.test',
      credentials: makeCommerceTenantWorkloadCredentials({
        [tenantId]: {
          coreIdentityApiKey: Redacted.make('test-only-workload-credential'),
          gatewayApiKey: Redacted.make('test-only-gateway-credential'),
        },
      }),
    }),
    Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
    Layer.succeed(CommerceEnrollmentOwnerTransactionRunner, {
      run: (scope, operation) => {
        expect(scope).toMatchObject({ legalEntityId, tenantId });
        return operation({ invoke });
      },
      runWorker: unused,
    }),
  );
  return {
    correlations,
    gate,
    gatewayRequests,
    layer: commerceCustomerAuthorityLive.pipe(Layer.provideMerge(dependencies)),
    observedReads,
    redeemed,
    requests,
    runtime,
    snapshot,
    state,
  };
});

it.effect('redeems a real customer assertion and runs the original registered retail access Read', () =>
  Effect.gen(function* exactSubject() {
    const h = yield* harness();
    yield* Effect.gen(function* checks() {
      const authority = yield* CommerceCustomerAuthority;
      expect(yield* authority.admit(input)).toMatchObject({
        authBindingId,
        partyId,
        principal: actor,
        principalId,
        profileId,
      });
      expect(h.gatewayRequests).toEqual([{ ...h.requests[0], audience: 'commerce-customer-context', legalEntityId }]);
      expect(h.observedReads).toEqual([[input.providerSubjectId, principalId, authBindingId]]);
      expect(h.redeemed).toHaveLength(1);
      expect(h.runtime.snapshot().evidenceWrites).toBeGreaterThan(0);
      yield* authority.admit({ ...input, permission: 'retail.consent.manage' });
      expect(h.redeemed).toHaveLength(2);
      expect(new Set(h.redeemed).size).toBe(2);
      expect(new Set(h.correlations).size).toBe(2);
    }).pipe(Effect.provide(h.layer));
  }),
);

type HarnessState = Effect.Success<ReturnType<typeof harness>>['state'];
const negatives = {
  'assertion-binding': (s: HarnessState) => {
    s.actor = Schema.decodeSync(TrustedPrincipalContextSchema)({ ...actor, authBindingId: otherId });
  },
  'assertion-company': (s: HarnessState) => {
    s.actor = Schema.decodeSync(TrustedPrincipalContextSchema)({ ...actor, legalEntityId: otherId });
  },
  'assertion-principal': (s: HarnessState) => {
    s.actor = Schema.decodeSync(TrustedPrincipalContextSchema)({ ...actor, principalId: otherId });
  },
  'assertion-session': (s: HarnessState) => {
    s.actor = Schema.decodeSync(TrustedPrincipalContextSchema)({ ...actor, authContextRef: 'foreign-session' });
  },
  'assertion-tenant': (s: HarnessState) => {
    s.actor = Schema.decodeSync(TrustedPrincipalContextSchema)({ ...actor, tenantId: otherId });
  },
  'binding-revoked': (s: HarnessState) => {
    s.coreDenied = true;
  },
  'foreign-profile': (s: HarnessState) => {
    s.bindingProfile = otherId;
  },
  'gate-denied': (s: HarnessState) => {
    s.gate = 'DENIED';
  },
  'gate-unavailable': (s: HarnessState) => {
    s.gate = 'UNAVAILABLE';
  },
  'identity-binding': (s: HarnessState) => {
    s.identity = Schema.decodeUnknownSync(ResolveExternalSubjectResultSchema)({ ...identity, authBindingId: otherId });
  },
  'identity-principal': (s: HarnessState) => {
    s.identity = Schema.decodeUnknownSync(ResolveExternalSubjectResultSchema)({ ...identity, principalId: otherId });
  },
  'identity-tenant': (s: HarnessState) => {
    s.identity = Schema.decodeUnknownSync(ResolveExternalSubjectResultSchema)({ ...identity, tenantId: otherId });
  },
  'invalid-signature': (s: HarnessState) => {
    s.invalidSignature = true;
  },
  'malformed-binding': (s: HarnessState) => {
    s.malformedBinding = true;
  },
  'owner-authorization-revoked': (s: HarnessState) => {
    s.authorizationState = 'REVOKED';
  },
  'owner-binding-revoked': (s: HarnessState) => {
    s.bindingState = 'REVOKED';
  },
  'principal-disabled': (s: HarnessState) => {
    s.coreDenied = true;
  },
  'retained-removed': (s: HarnessState) => {
    s.retained = false;
  },
  'stale-composition': (s: HarnessState) => {
    s.revision = 'b'.repeat(64);
  },
  'unrelated-principal': (s: HarnessState) => {
    s.bindingPrincipal = otherId;
  },
};
for (const [reason, change] of Object.entries(negatives)) {
  it.effect(`fails closed after current admission changes: ${reason}`, () =>
    Effect.gen(function* currentNegative() {
      const h = yield* harness();
      yield* Effect.gen(function* calls() {
        const authority = yield* CommerceCustomerAuthority;
        yield* authority.admit(input);
        change(h.state);
        const refused = yield* authority.admit(input).pipe(Effect.result);
        expect(Result.isFailure(refused)).toBe(true);
        if (Result.isFailure(refused)) {
          expect(
            Schema.is(
              reason === 'malformed-binding' || reason === 'gate-unavailable'
                ? CustomerAuthorityUnavailable
                : CustomerAuthorityRejected,
            )(refused.failure),
          ).toBe(true);
        }
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(TestClock.layer())),
  );
}

it.effect('fails before identity transport when a correlation UUID cannot be generated', () =>
  Effect.gen(function* unavailableCorrelation() {
    const crypto = yield* Crypto.Crypto;
    const h = yield* harness(
      Layer.succeed(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: () =>
          Effect.fail(PlatformError.systemError({ _tag: 'Unknown', method: 'randomUUIDv4', module: 'Crypto' })),
      }),
    );
    const failed = yield* CommerceCustomerAuthority.pipe(
      Effect.flatMap((authority) => authority.admit(input)),
      Effect.result,
      Effect.provide(h.layer),
    );
    expect(Result.isFailure(failed) && Schema.is(CustomerAuthorityUnavailable)(failed.failure)).toBe(true);
    expect(h.requests).toEqual([]);
    expect(h.observedReads).toEqual([]);
    expect(h.redeemed).toEqual([]);
  }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);
