import { randomUUID } from 'node:crypto';

import { ActionRuntime, ActiveApplicationCompositionService, ContextAccessLive } from '@app/core-runtime';
import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { GatewayPrincipalVerifierLive } from '@app/gateway-principal-verifier/server';
import { PartyDetailResponseSchema } from '@app/party-registry/api/client';
import {
  ApiKeyGatewayContextRequestSchema,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  shellGatewayContextContract,
} from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { sql } from 'drizzle-orm';
import { ConfigProvider, Context, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import type { Crypto, Scope } from 'effect';
import { FetchHttpClient, HttpServerResponse } from 'effect/http';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { bindRetailPortalProfileActionApiLive } from '../../api/bind-retail-portal-profile-action-server.ts';
import { enrollmentCommandRecoveryLive } from '../../api/enrollment-command-recovery.ts';
import { ensureRetailCustomerProfileActionApiLive } from '../../api/ensure-retail-customer-profile-action-server.ts';
import { BindRetailPortalProfileActionApi } from '../../shared/apis/bind-retail-portal-profile-action.ts';
import { EnsureRetailCustomerProfileActionApi } from '../../shared/apis/ensure-retail-customer-profile-action.ts';
import {
  EnrollmentCommandRecoveryApi,
  EnrollmentCommandRecoveryInputSchema,
} from '../../shared/enrollment-command-recovery-api.ts';
import type { RetailCustomerProfileRefSchema } from '../../shared/resources/retail-customer-profile.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { bindRetailPortalProfileAction } from '../../src/actions/bind-retail-portal-profile.action.ts';
import { ensureRetailCustomerProfileAction } from '../../src/actions/ensure-retail-customer-profile.action.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../../src/enrollment/attempts/errors.ts';
import { COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY } from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { RetailPartyDetailExecutor } from '../../src/integrations/retail-party-detail-executor.ts';
import {
  ProfileRetailPermissionReaderFactory,
  profileRetailPermissionReaderFactoryLive,
} from '../../src/integrations/retail-permission-reader.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import {
  readRetailPortalBindingForPrincipal,
  readRetailProfileByParty,
} from '../../src/persistence/profile-persistence.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../../src/profile-counterparty-role-eligibility.ts';
import { enrollmentApplicationCompositionSnapshot } from './enrollment-application-composition.ts';

const ownerAudience = 'commerce-customer-context';
const recoveryPath = '/api/enrollment/commands/resolve';
const ownerApiPrefix = '/commerce-customer-context-api';
const AssertionIdentitySchema = Schema.Struct({ jti: Schema.String.check(Schema.isUUID()) });

interface OwnerHttpObservation {
  readonly actionKey: string;
  readonly idempotencyKey: string | null;
  readonly jti: string;
  readonly kind: 'recovery' | 'retry';
  readonly status: number;
}

class EnrollmentProfileTransportError extends Schema.TaggedError<EnrollmentProfileTransportError>()(
  'EnrollmentProfileTransportError',
  { reason: Schema.String },
) {}

const ownerReadUnavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(
    new CommerceEnrollmentAttemptUnavailable({ code: 'attempt_unavailable', reason, retryable: true }),
    'cause',
    { value: cause },
  );

const acquireProfileDatabase = Effect.gen(function* acquireProfileDatabase() {
  const snapshot = yield* enrollmentApplicationCompositionSnapshot;
  // The existing Current-access fixture capability covers these two Retail owner transitions.
  // Clone installed schema only. No source data, function replacement or migration replay.
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1232-current-access',
  });
  return { connections: isolated.connections, snapshot };
});

const EnrollmentProfileDatabase = Context.Service<Effect.Success<typeof acquireProfileDatabase>>(
  '@app/commerce-customer-context/tests/EnrollmentProfileDatabase',
);

/** One owned database for this suite; each test still owns fresh Core identities and scoped roles. */
export const enrollmentProfileReconciliationLayer = Layer.effect(
  EnrollmentProfileDatabase,
  acquireProfileDatabase,
).pipe(
  Layer.provideMerge(
    NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer)),
  ),
);

export const makeEnrollmentProfileReconciliationFixture = Effect.fn('EnrollmentProfileReconciliation.fixture')(
  function* makeEnrollmentProfileReconciliationFixture() {
    const { connections, snapshot } = yield* EnrollmentProfileDatabase;
    const compositionRevision = snapshot.composition.revision;
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionExecutor: 'manager-only',
        actionKeys: [
          ensureRetailCustomerProfileAction.descriptor.actionKey,
          bindRetailPortalProfileAction.descriptor.actionKey,
        ],
        adminConnectionString: Redacted.make(connections.admin.connectionString),
        allowedAudiences: [ownerAudience],
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        authenticationSubjectTypes: ['user', 'api_key'],
        compositionRevision,
        managerAuthenticationMethod: 'api_key',
        moduleAccess: 'configured-modules',
        moduleKeys: [COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY],
        runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
      }),
      (resource) => resource.close().pipe(Effect.orDie),
    );
    const at = yield* DateTime.now;
    const partyResourceId = randomUUID();
    const partyRef = {
      moduleId: 'party.registry',
      resourceId: partyResourceId,
      resourceType: 'party.registry.party',
      tenantId: fixture.tenantId,
    } as const;
    const sellingLegalEntityRef = {
      moduleId: 'core.identity',
      resourceId: fixture.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: fixture.tenantId,
    } as const;
    const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
    const retailReader = profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(ContextAccessLive));
    const owners = Layer.mergeAll(
      // Only the external Party fact is a TEST input. The production profile preflight binds it to
      // the exact native invocation; unknown Party/Tenant references remain invalid.
      Layer.succeed(RetailPartyDetailExecutor, {
        execute: ({ partyRef: requested }) =>
          Effect.sync(() =>
            Schema.decodeUnknownSync(PartyDetailResponseSchema)({
              currentFactAssertions: [],
              factHistory: null,
              party: {
                archivedAt:
                  requested.tenantId === partyRef.tenantId && requested.resourceId === partyResourceId
                    ? null
                    : DateTime.formatIso(at),
                createdAt: DateTime.formatIso(at),
                displayName: 'Enrollment profile reconciliation Party',
                partyRef: requested,
                partyType: 'PERSON',
                revision: 1,
                updatedAt: DateTime.formatIso(at),
              },
              resolution: {
                aliasChain: [],
                canonicalPartyRef: requested,
                kind: 'DIRECT',
                requestedPartyRef: requested,
              },
            }),
          ),
      }),
      partyRegistryRetailPartyResolverFactoryLive,
      partyRegistryGuestResolverFactoryLive,
      profileCounterpartyRoleEligibilityResolverFactoryLive,
      profileReactivationEligibilityEvaluatorFactoryLive.pipe(
        Layer.provide(profileReconfirmationPolicyUnavailableLive),
      ),
      retailReader,
      commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(Layer.provide(retailReader)),
    );
    const ambient = yield* Effect.context<Crypto.Crypto | Scope.Scope>();
    const context = Context.merge(ambient, yield* Layer.build(fixture.layer.pipe(Layer.provideMerge(owners))));
    const runtime = Context.get(context, ActionRuntime);
    const recoveries: {
      readonly input: Parameters<typeof runtime.resolveActionExecution>[0];
      readonly result: Effect.Success<ReturnType<typeof runtime.resolveActionExecution>>;
    }[] = [];
    const observedRuntime = {
      ...runtime,
      resolveActionExecution: (input: Parameters<typeof runtime.resolveActionExecution>[0]) =>
        runtime.resolveActionExecution(input).pipe(
          Effect.tap((result) => Effect.sync(() => recoveries.push({ input, result }))),
          Effect.tapError((failure) =>
            Effect.logWarning('ENROLLMENT_PROFILE_NATIVE_RECOVERY_FAILED', { code: failure.code }),
          ),
        ),
    };
    const run: CommerceEnrollmentOwnerTransactionRun = (scope, operation) => {
      if (scope.tenantId !== fixture.tenantId || scope.legalEntityId !== fixture.legalEntityId) {
        return Effect.fail(ownerReadUnavailable('Native profile recovery scope mismatch'));
      }
      return fixture
        .prepareOwner((transaction) => operation(transaction), 'required')
        .pipe(
          Effect.provideContext(context),
          Effect.mapError((cause) => ownerReadUnavailable('Native profile owner read unavailable', cause)),
        );
    };
    const epoch = () =>
      fixture
        .prepareOwner(
          (transaction) =>
            transaction
              .select({ epoch: sql<number>`floor(extract(epoch from clock_timestamp()))::integer` })
              .from(sql`(select 1) as profile_recovery_clock`)
              .pipe(
                Effect.flatMap(([row]) =>
                  row === undefined
                    ? Effect.fail(new EnrollmentProfileTransportError({ reason: 'Native issuance clock unavailable' }))
                    : Effect.succeed(row.epoch),
                ),
              ),
          'required',
        )
        .pipe(Effect.provideContext(context));

    const keys = yield* Effect.promise(
      async () => await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }),
    );
    const publicJwk = yield* Effect.promise(async () => await exportJWK(keys.publicKey));
    const origin = `https://enrollment-profile-${randomUUID()}.test`;
    const issuer = `${origin}/issuer`;
    const apiKey = `enrollment-profile-${randomUUID()}`;
    const configuration = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY: apiKey,
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
          keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'owned-profile', use: 'sig' }],
        }),
        ONTOS_SHELL_GATEWAY_BASE_URL: `${origin}/shell-super-app-api`,
      }),
    );
    const composition = Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) });
    const consumed = new Set<string>();
    const api = HttpApi.make('CommerceCustomerContextApi')
      .addHttpApi(EnrollmentCommandRecoveryApi)
      .addHttpApi(EnsureRetailCustomerProfileActionApi)
      .addHttpApi(BindRetailPortalProfileActionApi);
    const recoveryServices = Layer.mergeAll(
      Layer.succeed(ActionRuntime, observedRuntime),
      GatewayPrincipalVerifierLive.pipe(Layer.provide(configuration)),
      composition,
      Layer.succeed(GatewayAssertionRedemptionService, {
        consume: ({ jti }) =>
          consumed.has(jti)
            ? Effect.fail(new GatewayAssertionReplayError({ reason: 'The recovery assertion was already redeemed' }))
            : Effect.sync(() => {
                consumed.add(jti);
              }),
      }),
      HttpServer.layerServices,
    );
    const recoveryContext = Context.merge(context, yield* Layer.build(recoveryServices));
    const apiLayer = HttpApiBuilder.layer(api).pipe(
      Layer.provide(
        Layer.mergeAll(
          enrollmentCommandRecoveryLive,
          ensureRetailCustomerProfileActionApiLive,
          bindRetailPortalProfileActionApiLive,
        ),
      ),
      Layer.provide(recoveryServices),
    );
    const issuances: string[] = [];
    const shellIssuance = HttpRouter.add('POST', shellGatewayContextContract.issueApiKeyGatewayContextPath, (request) =>
      Effect.gen(function* ownedShellIssuance() {
        const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApiKeyGatewayContextRequestSchema))(
          yield* request.text,
        );
        if (
          request.headers['x-api-key'] !== apiKey ||
          payload.audience !== ownerAudience ||
          payload.compositionRevision !== compositionRevision ||
          payload.legalEntityId !== fixture.legalEntityId
        ) {
          return yield* new EnrollmentProfileTransportError({
            reason: 'The owned Shell refused the issuance scope',
          });
        }
        const issuedAt = yield* epoch();
        const jti = randomUUID();
        const token = yield* Effect.promise(
          async () =>
            await new SignJWT({
              compositionRevision,
              principal,
              targetBuildMarker: ultramodernApiMarker.buildMarker,
              ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
            })
              .setProtectedHeader({ alg: 'EdDSA', kid: 'owned-profile', typ: 'JWT' })
              .setAudience(ownerAudience)
              .setIssuer(issuer)
              .setSubject(principal.principalId)
              .setIssuedAt(issuedAt)
              .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
              .setJti(jti)
              .sign(keys.privateKey),
        );
        issuances.push(jti);
        return yield* HttpServerResponse.json({
          apiBaseUrl: ownerApiPrefix,
          compositionRevision,
          expiresAt: issuedAt + GATEWAY_ASSERTION_TTL_SECONDS,
          token,
        });
      }),
    );
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(Layer.mergeAll(apiLayer, shellIssuance), { disableLogger: true })),
      (handler) => Effect.promise(async () => await handler.dispose()).pipe(Effect.orDie),
    );
    const httpRequests: OwnerHttpObservation[] = [];
    const ownerRoutes = [
      {
        actionKey: ensureRetailCustomerProfileAction.descriptor.actionKey,
        path: EnsureRetailCustomerProfileActionApi.groups.ensureRetailCustomerProfileAction.endpoints.execute.path,
      },
      {
        actionKey: bindRetailPortalProfileAction.descriptor.actionKey,
        path: BindRetailPortalProfileActionApi.groups.bindRetailPortalProfileAction.endpoints.execute.path,
      },
    ];
    const isOwnedRequest = (url: URL, method: string) =>
      url.origin === origin && url.search === '' && url.hash === '' && method === 'POST';
    const boundedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!isOwnedRequest(url, request.method)) {
        throw new EnrollmentProfileTransportError({ reason: 'A request left the owned profile transport' });
      }
      if (url.pathname === shellGatewayContextContract.issueApiKeyGatewayContextPath) {
        return await app.handler(request, recoveryContext);
      }
      const recovery = url.pathname === `${ownerApiPrefix}${recoveryPath}`;
      const retryRoute = ownerRoutes.find(({ path }) => url.pathname === `${ownerApiPrefix}${path}`);
      if ((!recovery && retryRoute === undefined) || request.headers.get('x-api-key') !== null) {
        throw new EnrollmentProfileTransportError({
          reason: 'Only owned recovery and exact owner Actions are mounted',
        });
      }
      const authorization = request.headers.get('authorization');
      if (authorization === null || !authorization.startsWith('Bearer ')) {
        throw new EnrollmentProfileTransportError({ reason: 'The owner request has no signed assertion' });
      }
      // Identity extraction observes transport only. Each real handler still verifies and redeems
      // its assertion, and Core remains the sole source of command execution and recovery results.
      const { jti } = Schema.decodeUnknownSync(AssertionIdentitySchema)(decodeJwt(authorization.slice(7)));
      const body = await request.text();
      const recoveryInput = recovery
        ? Schema.decodeUnknownSync(Schema.fromJsonString(EnrollmentCommandRecoveryInputSchema))(body)
        : undefined;
      const actionKey = recoveryInput?.actionKey ?? retryRoute?.actionKey;
      if (actionKey === undefined) {
        throw new EnrollmentProfileTransportError({ reason: 'The owned request names no owner Action' });
      }
      url.pathname = retryRoute?.path ?? recoveryPath;
      const response = await app.handler(
        new Request(url, { body, headers: request.headers, method: request.method }),
        recoveryContext,
      );
      httpRequests.push({
        actionKey,
        idempotencyKey: recoveryInput?.idempotencyKey ?? request.headers.get('idempotency-key'),
        jti,
        kind: recovery ? 'recovery' : 'retry',
        status: response.status,
      });
      return response;
    };
    const transport = Layer.mergeAll(
      configuration,
      Layer.succeed(FetchHttpClient.Fetch, boundedFetch),
      FetchHttpClient.layer,
    );
    const correlationId = `enrollment-profile-reconciliation-${randomUUID()}`;
    const ensureInvocationId = randomUUID();
    const bindInvocationId = randomUUID();
    const attemptId = randomUUID();
    return {
      actorPrincipalId: principal.principalId,
      at,
      attemptId,
      bind: (profileRef: typeof RetailCustomerProfileRefSchema.Type, idempotencyKey = bindInvocationId) =>
        runtime
          .runAction({
            payload: {
              effectiveAt: DateTime.formatIso(at),
              enrollmentEvidenceRef: attemptId,
              expectedRevision: null,
              expectedState: null,
              principalRef: {
                moduleId: 'core.identity',
                resourceId: principal.principalId,
                resourceType: 'core.identity.principal',
                tenantId: fixture.tenantId,
              },
              profileRef,
              reason: 'Retail self-enrollment established the portal profile binding',
              sellingLegalEntityRef,
            },
            principal,
            registration: bindRetailPortalProfileAction,
            transport: { correlationId, idempotencyKey, targetModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY },
          })
          .pipe(Effect.provideContext(context)),
      bindInvocationId,
      compositionRevision,
      ensure: (idempotencyKey = ensureInvocationId) =>
        runtime
          .runAction({
            payload: {
              effectiveAt: DateTime.formatIso(at),
              subject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef },
              trigger: 'AUTHORIZED_ONBOARDING',
            },
            principal,
            registration: ensureRetailCustomerProfileAction,
            transport: { correlationId, idempotencyKey, targetModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY },
          })
          .pipe(Effect.provideContext(context)),
      ensureInvocationId,
      httpRequests,
      issuances,
      legalEntityId: fixture.legalEntityId,
      loseNextAcknowledgement: () => fixture.faultNextTransaction('lost-ack'),
      partyResourceId,
      readBinding: (profileRef: typeof RetailCustomerProfileRefSchema.Type) =>
        run({ legalEntityId: fixture.legalEntityId, tenantId: fixture.tenantId }, (invoker) =>
          readRetailPortalBindingForPrincipal(
            invoker,
            {
              legalEntityId: fixture.legalEntityId,
              principalId: principal.principalId,
              tenantId: fixture.tenantId,
            },
            profileRef.resourceId,
          ).pipe(Effect.mapError((cause) => ownerReadUnavailable('The native binding could not be read', cause))),
        ),
      reader: Context.get(context, ProfileRetailPermissionReaderFactory),
      readProfile: () =>
        run({ legalEntityId: fixture.legalEntityId, tenantId: fixture.tenantId }, (invoker) =>
          readRetailProfileByParty(invoker, partyResourceId).pipe(
            Effect.mapError((cause) => ownerReadUnavailable('The native profile could not be read', cause)),
          ),
        ),
      recoveries,
      redeemedAssertions: () => [...consumed],
      redemptionCount: () => consumed.size,
      resolveCommand: (actionKey: string, idempotencyKey: string) =>
        runtime.resolveActionExecution({ actionKey, idempotencyKey, principal }).pipe(Effect.provideContext(context)),
      run,
      tenantId: fixture.tenantId,
      transport,
    };
  },
);
