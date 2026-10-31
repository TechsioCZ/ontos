import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  ContextAccessLive,
  defineScopedRoutine,
  runAction,
} from '@app/core-runtime';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { configuredGatewayAssertionRedemptionLive } from '../../api/index.ts';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { ConfigProvider, Context, Deferred, Effect, Layer, Option, Redacted, Result, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';

import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { RetailPortalBindingResultSchema } from '../../shared/actions/bind-retail-portal-profile.ts';
import {
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  RetailPortalPermissionCodeSchema,
} from '../../shared/domain/profile-contracts.ts';
import {
  InvoiceRecipientResolutionRequestSchema,
  InvoiceRecipientResolutionUnavailableProblemSchema,
} from '../../shared/apis/invoice-recipient-resolution.ts';
import {
  DeliveryDestinationResolutionRequestSchema,
  DeliveryDestinationResolutionUnavailableProblemSchema,
} from '../../shared/apis/delivery-destination-resolution.ts';
import { executeInvoiceRecipientResolutionWithAuthorization } from '../../src/api/invoice-recipient-resolution-client.ts';
import { executeDeliveryDestinationResolutionWithAuthorization } from '../../src/api/delivery-destination-resolution-client.ts';
import { addSavedAddressAction } from '../../src/actions/add-saved-address.action.ts';
import { changeRetailPaymentTermPreferenceAction } from '../../src/actions/change-retail-payment-term-preference.action.ts';
import { PaymentTermCatalogGatewayCredentialService } from '../../shared/domain/payment-term-catalog-gateway-credential.ts';
import { PaymentTermDefinitionSchema } from '@app/payment-term-catalog-contracts/payment-term';
import {
  CurrentPaymentTermsRequestSchema,
  CurrentPaymentTermsResponseSchema,
} from '@app/payment-term-catalog-contracts/current-payment-terms';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import {
  deliveryDestinationPortsForTransaction,
  invoiceRecipientPortsForTransaction,
} from '../../src/persistence/address-persistence.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { servePurchaseFixtureHttpServer } from '../support/purchase-fixture-http-server.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeCrypto.layer),
);
const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const ReceiverMarkerSchema = Schema.Struct({
  appId: Schema.Literal('commerce-customer-context'),
  buildMarker: Schema.String,
});
const ReceiverReadySchema = Schema.Struct({
  marker: ReceiverMarkerSchema,
  port: Schema.Number,
  type: Schema.Literal('ready'),
});
const ProfileResultSchema = Schema.Struct({
  outcome: Schema.Literal('PROFILE_CREATED'),
  payload: Schema.Struct({
    profileRef: Schema.Struct({ resourceId: Schema.String.pipe(Schema.brand('NativeProfileResourceId')) }),
  }),
});

const ensureProfile = defineScopedRoutine({
  name: 'ensure_retail_profile',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: ProfileResultSchema,
  routineKey: 'test.native-profile',
  schema: 'commerce_customer_context',
});
const persistPaymentTerms = defineScopedRoutine({
  name: 'persist_customer_payment_terms',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ] as const,
  resultSchema: Schema.Struct({ outcome: Schema.String, payload: Schema.Unknown }),
  routineKey: 'test.retail-payment-terms-seed',
  schema: 'commerce_customer_context',
});
const bindProfile = defineScopedRoutine({
  name: 'mutate_retail_portal_binding',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: Schema.Literal('BINDING_ACTIVATED'),
    payload: RetailPortalBindingResultSchema,
  }),
  routineKey: 'test.native-binding',
  schema: 'commerce_customer_context',
});
const NativeIdentitySchema = Schema.String.pipe(Schema.brand('NativeIdentity'));
const readBindingIntent = defineScopedRoutine({
  name: 'read_retail_portal_profile_binding_permission_mutation',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: Schema.Literal('AUTHORIZATION_AVAILABLE'),
    payload: Schema.Struct({
      actionInvocationId: NativeIdentitySchema,
      bindingId: NativeIdentitySchema,
      mutationId: NativeIdentitySchema,
      operation: Schema.Literal('grant'),
      permission: RetailPortalPermissionCodeSchema,
      principalId: NativeIdentitySchema,
      profileId: NativeIdentitySchema,
      state: Schema.Literal('PENDING_GRANT'),
    }),
  }),
  routineKey: 'profile.binding-authorization-intent-read',
  schema: 'commerce_customer_context',
});
const BindingFinalizedOutcomeSchema = Schema.Literals(['AUTHORIZATION_FINALIZED', 'AUTHORIZATION_ALREADY_FINAL']);
const finalizeBindingIntent = defineScopedRoutine({
  name: 'finalize_retail_portal_profile_binding_permission_mutation',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: BindingFinalizedOutcomeSchema,
    payload: Schema.Struct({ state: Schema.Literal('ACTIVE') }),
  }),
  routineKey: 'profile.binding-authorization-intent-finalize',
  schema: 'commerce_customer_context',
});
const finalizeBinding = defineScopedRoutine({
  name: 'finalize_retail_portal_binding_authorization',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: BindingFinalizedOutcomeSchema,
    payload: Schema.Struct({ authorizationState: Schema.Literal('ACTIVE') }),
  }),
  routineKey: 'profile.binding-authorization-finalize',
  schema: 'commerce_customer_context',
});
const readBindingAuthority = defineScopedRoutine({
  name: 'read_retail_portal_binding_authorization',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: Schema.Literal('AUTHORIZATION_AVAILABLE'),
    payload: Schema.Struct({
      authorizationState: Schema.Literal('ACTIVE'),
      pendingCount: Schema.Int,
      terminalCount: Schema.Int,
    }),
  }),
  routineKey: 'profile.binding-authorization-read',
  schema: 'commerce_customer_context',
});
const probeNativeGateway = Effect.fn('PurchasePermissionTest.probeNativeGateway')(function* probeNativeGateway(
  environment: Readonly<{
    APP_ENV_PATH: string;
    DATABASE_URL: string;
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: string;
    ONTOS_GATEWAY_ISSUER: string;
    ONTOS_GATEWAY_PUBLIC_JWKS: string;
  }>,
  marker: typeof ReceiverMarkerSchema.Type,
  diagnosticToken: string,
  secondToken: string,
) {
  // Probe the same genuine configuration, source and durable redemption as the child, using a
  // separate freshly signed assertion. This cannot consume any request's assertion or grant access.
  const diagnosticConfiguration = ConfigProvider.layer(ConfigProvider.fromUnknown(environment));
  const diagnosticComposition = ActiveApplicationCompositionConfigLive.pipe(
    Layer.provideMerge(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer))),
    Layer.provide(diagnosticConfiguration),
  );
  const diagnosticContext = yield* Layer.build(
    Layer.mergeAll(
      diagnosticComposition,
      configuredGatewayAssertionRedemptionLive.pipe(Layer.provide(diagnosticConfiguration)),
    ),
  );
  yield* Context.get(diagnosticContext, ActiveApplicationCompositionSource).load.pipe(Effect.orDie);
  yield* Context.get(diagnosticContext, ActiveApplicationCompositionService).load.pipe(Effect.orDie);
  const diagnosticVerifier = bindGatewayPrincipalVerifier('commerce-customer-context', marker);
  const diagnosticAssertion = Redacted.make(`Bearer ${diagnosticToken}`);
  const verification = yield* diagnosticVerifier
    .verify(diagnosticAssertion, { environment })
    .pipe(
      Effect.provideService(
        ActiveApplicationCompositionService,
        Context.get(diagnosticContext, ActiveApplicationCompositionService),
      ),
      Effect.result,
    );
  if (Result.isFailure(verification)) {
    return yield* Effect.die(verification.failure);
  }
  const claims = decodeJwt(diagnosticToken);
  if (claims.jti === undefined || claims.exp === undefined) {
    return yield* Effect.die('The diagnostic assertion has no redemption identity');
  }
  const redemption = Context.get(diagnosticContext, GatewayAssertionRedemptionService);
  // Probe redemption separately so a native SQL error retains its cause instead of being
  // sanitized by the gateway verifier; only the independently signed diagnostic JTI is spent.
  yield* redemption
    .consume({
      audience: 'commerce-customer-context',
      expiresAtEpochSeconds: claims.exp,
      issuer: environment.ONTOS_GATEWAY_ISSUER,
      jti: claims.jti,
    })
    .pipe(Effect.orDie);
  const diagnosticReplay = yield* redemption
    .consume({
      audience: 'commerce-customer-context',
      expiresAtEpochSeconds: claims.exp,
      issuer: environment.ONTOS_GATEWAY_ISSUER,
      jti: claims.jti,
    })
    .pipe(Effect.result);
  expect(Result.isFailure(diagnosticReplay)).toBe(true);
  if (Result.isFailure(diagnosticReplay)) {
    expect(Schema.is(GatewayAssertionReplayError)(diagnosticReplay.failure)).toBe(true);
  }
  const redeemed = yield* diagnosticVerifier
    .verifyAndRedeem(Redacted.make(`Bearer ${secondToken}`), {
      environment,
      redemption,
    })
    .pipe(
      Effect.provideService(
        ActiveApplicationCompositionService,
        Context.get(diagnosticContext, ActiveApplicationCompositionService),
      ),
      Effect.result,
    );
  if (Result.isFailure(redeemed)) {
    return yield* Effect.die(redeemed.failure);
  }
  return yield* Effect.void;
});

const nativePurchasePermissionPlans = Effect.gen(function* nativePurchasePermissionPlansEffect() {
  const artifact = fileURLToPath(new URL(`../../node_modules/.cache/ontos-1268/${randomUUID()}.mjs`, import.meta.url));
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifact, { force: true })));
  const bundle = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      'exec',
      'esbuild',
      'verticals/commerce-customer-context/tests/support/purchase-resolution-permission-plan-receiver.fixture.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      `--outfile=${artifact}`,
    ],
    { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [bundleExit] = yield* Effect.all(
    [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
    { concurrency: 3 },
  );
  expect(bundleExit).toBe(0);
  const description = yield* ChildProcess.make(process.execPath, [artifact, '--describe'], {
    cwd: appRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [markerLines, descriptionExit] = yield* Effect.all(
    [
      description.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
      description.exitCode,
      Stream.runDrain(description.stderr),
    ],
    { concurrency: 3 },
  );
  expect(descriptionExit).toBe(0);
  const marker = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiverMarkerSchema))(markerLines[0]);
  const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(marker.buildMarker, []);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1268-address-plan',
  });
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionKeys: [
        addSavedAddressAction.descriptor.actionKey,
        changeRetailPaymentTermPreferenceAction.descriptor.actionKey,
      ],
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context'],
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: ['commerce.customer-context'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const adminContext = yield* Layer.build(
    PgClient.layerFrom(PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) })).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
  const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
    Effect.provideService(PgClient.PgClient, Context.get(adminContext, PgClient.PgClient)),
  );
  const [identity] = yield* admin.execute<{ readonly database: string }>(
    sql`select current_database() as database`,
    'objects',
  );
  expect(identity?.database).toBe(isolated.connections.runtime.database);
  const ownerLayer = commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
    Layer.provide(profileRetailPermissionReaderFactoryLive),
    Layer.provide(ContextAccessLive),
  );
  const context = yield* Layer.build(fixture.layer.pipe(Layer.provide(ownerLayer)));
  yield* fixture
    .prepareOwner((transaction, scope) =>
      Effect.gen(function* defaultTenantOnlyScope() {
        expect(scope.legalEntityId).toBeUndefined();
        const [installed] = yield* transaction
          .select({
            legalEntityId: sql<string>`current_setting('ontos.legal_entity_id')`,
            tenantId: sql<string>`current_setting('ontos.tenant_id')`,
          })
          .from(sql`(select 1) as native_context`);
        expect(installed).toEqual({ legalEntityId: '', tenantId: fixture.tenantId });
      }),
    )
    .pipe(Effect.provideContext(context));
  const prepared = yield* fixture
    .prepareOwner(
      (transaction, scope) =>
        Effect.gen(function* nativeRetailProfile() {
          expect(scope.legalEntityId).toBe(fixture.legalEntityId);
          const [installed] = yield* transaction
            .select({
              at: sql<string>`to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,

              legalEntityId: sql<string>`current_setting('ontos.legal_entity_id')`,
              tenantId: sql<string>`current_setting('ontos.tenant_id')`,
            })
            .from(sql`(select 1) as native_context`);
          expect(installed).toMatchObject({ legalEntityId: fixture.legalEntityId, tenantId: fixture.tenantId });
          if (installed === undefined) {
            return yield* Effect.die('No verified native operation clock');
          }
          const { at } = installed;
          const ensured = yield* transaction.invoke(ensureProfile, [
            randomUUID(),
            null,
            'AUTHENTICATED',
            at,
            'AUTHORIZED_ONBOARDING',
            randomUUID(),
            fixture.manager.principalId,
          ]);
          const [row] = ensured;
          if (row === undefined) {
            return yield* Effect.die('No native Profile producer result');
          }
          const created = row.payload.profileRef.resourceId;
          const bindingInvocationId = randomUUID();
          const bound = yield* transaction.invoke(bindProfile, [
            created,
            fixture.manager.principalId,
            fixture.manager.authBindingId,
            'native-permission-plan',
            null,
            null,
            'BIND',
            at,
            'Native purchase permission proof',
            bindingInvocationId,
            fixture.manager.principalId,
          ]);
          const [binding] = bound;
          if (binding === undefined) {
            return yield* Effect.die('No native binding receipt');
          }
          expect(binding.payload.authorizationState).toBe('PENDING_GRANT');
          return { at, binding: binding.payload, bindingInvocationId, profileId: created };
        }),
      'required',
    )
    .pipe(Effect.provideContext(context));
  const { profileId } = prepared;
  const profile = {
    kind: 'RETAIL',
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: profileId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: fixture.tenantId,
    },
  } as const;
  const mutationContext = yield* Layer.build(BusinessPermissionRelationshipMutationLive);
  const business = Context.get(mutationContext, BusinessPermissionRelationshipMutation);
  const intents = prepared.binding.permissionMutations;
  if (intents === undefined) {
    return yield* Effect.die('No durable Retail binding intents');
  }
  expect(intents).toHaveLength(RETAIL_PORTAL_SELF_SERVICE_BASELINE.length);
  expect(new Set(intents.map(({ permission }) => permission))).toEqual(new Set(RETAIL_PORTAL_SELF_SERVICE_BASELINE));
  for (const intent of intents) {
    const grant = {
      permission: intent.permission,
      principal: { principalId: fixture.manager.principalId, tenantId: fixture.tenantId },
      target: {
        kind: 'retail_profile' as const,
        legalEntityId: fixture.legalEntityId,
        profileId,
        tenantId: fixture.tenantId,
      },
    };
    yield* fixture
      .prepareOwner(
        (transaction) =>
          Effect.gen(function* reconcileExactBindingIntent() {
            const [current] = yield* transaction.invoke(readBindingIntent, [intent.mutationId]);
            expect(current?.payload).toMatchObject({
              actionInvocationId: prepared.bindingInvocationId,
              bindingId: prepared.binding.bindingRef.resourceId,
              mutationId: intent.mutationId,
              operation: 'grant',
              permission: intent.permission,
              principalId: fixture.manager.principalId,
              profileId,
              state: 'PENDING_GRANT',
            });
            yield* business.mutate({ ...grant, operation: 'grant' });
            yield* transaction.invoke(finalizeBindingIntent, [intent.mutationId, 'grant', 'ACTIVE']);
          }),
        'required',
      )
      .pipe(Effect.provideContext(context));
    yield* Effect.addFinalizer(() => business.mutate({ ...grant, operation: 'revoke' }).pipe(Effect.orDie));
  }
  yield* fixture
    .prepareOwner(
      (transaction) =>
        Effect.gen(function* finalizeExactBindingAuthority() {
          yield* transaction.invoke(finalizeBinding, [
            prepared.binding.bindingRef.resourceId,
            'grant',
            prepared.binding.revision,
            prepared.bindingInvocationId,
            prepared.at,
            'Native purchase permission proof',
            fixture.manager.principalId,
          ]);
          const [authority] = yield* transaction.invoke(readBindingAuthority, [
            prepared.binding.bindingRef.resourceId,
            'grant',
          ]);
          expect(authority?.payload).toMatchObject({
            authorizationState: 'ACTIVE',
            pendingCount: 0,
            terminalCount: RETAIL_PORTAL_SELF_SERVICE_BASELINE.length,
          });
        }),
      'required',
    )
    .pipe(Effect.provideContext(context));
  for (const permission of ['retail.address_book.manage', 'retail.address_book.use'] as const) {
    for (const actor of [fixture.legalEntityOnly]) {
      const grant = {
        permission,
        principal: { principalId: actor.principalId, tenantId: fixture.tenantId },
        target: {
          kind: 'retail_profile' as const,
          legalEntityId: fixture.legalEntityId,
          profileId,
          tenantId: fixture.tenantId,
        },
      };
      yield* business.mutate({ ...grant, operation: 'grant' });
      yield* Effect.addFinalizer(() => business.mutate({ ...grant, operation: 'revoke' }).pipe(Effect.orDie));
    }
  }
  yield* fixture.grantResourceAccess(profile.profileRef, fixture.manager.principalId);

  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const produced = yield* runAction({
    payload: {
      origin: {
        kind: 'COMMERCE_ONLY',
        postalAddress: { addressLine1: '1 Native Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
      },
      profile,
      purposes: ['BILLING', 'DELIVERY'],
      reason: 'Native purchase permission plan',
    },
    principal,
    registration: addSavedAddressAction,
    transport: {
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      targetModuleKey: 'commerce.customer-context',
    },
  }).pipe(Effect.provideContext(context));
  expect(produced.outcome).toBe('ADDED');
  const evidence = yield* fixture.evidence(coreEvidenceExecutor);
  expect(evidence.invocations.some((invocation) => invocation.status === 'succeeded')).toBe(true);
  expect(evidence.events).toHaveLength(1);
  expect(evidence.outbox).toHaveLength(1);
  // Bind the optional capability explicitly; the launch baseline remains unchanged.
  const optionalPermission = 'retail.settings.payment_term_preference.manage' as const;
  expect(RETAIL_PORTAL_SELF_SERVICE_BASELINE).not.toContain(optionalPermission);
  const optionalGrant = {
    permission: optionalPermission,
    principal: { principalId: fixture.manager.principalId, tenantId: fixture.tenantId },
    target: {
      kind: 'retail_profile' as const,
      legalEntityId: fixture.legalEntityId,
      profileId,
      tenantId: fixture.tenantId,
    },
  };
  yield* business.mutate({ ...optionalGrant, operation: 'grant' });
  yield* Effect.addFinalizer(() => business.mutate({ ...optionalGrant, operation: 'revoke' }).pipe(Effect.orDie));
  const termId = randomUUID();
  const termRef = {
    moduleId: 'payment.term-catalog' as const,
    resourceId: termId,
    resourceType: 'payment.term-catalog.payment-term' as const,
    tenantId: fixture.tenantId,
  };
  const entitlementRef = {
    moduleId: 'commerce.customer-context' as const,
    resourceId: randomUUID(),
    resourceType: 'commerce.customer-context.customer-payment-term-entitlement' as const,
    tenantId: fixture.tenantId,
  };
  const effectiveFrom = '2027-01-01T00:00:00.000Z';
  const seeded = yield* fixture
    .prepareOwner(
      (transaction) =>
        transaction.invoke(persistPaymentTerms, [
          {
            actionInvocationId: randomUUID(),
            changed: true,
            counterpartyResourceId: null,
            expectedRevision: 1,
            principalId: fixture.manager.principalId,
            profileKind: 'RETAIL',
            profileResourceId: profileId,
            reason: 'Native optional Payment Term entitlement',
            state: {
              entitlements: [
                {
                  effectiveFrom,
                  entitlementRef,
                  originalEffectiveTo: null,
                  paymentTermRef: termRef,
                  semanticRevisionId: termId,
                  status: 'ACTIVE',
                },
              ],
              preferences: [],
              profileRef: profile.profileRef,
              revision: 2,
            },
          },
        ]),
      'required',
    )
    .pipe(Effect.provideContext(context));
  expect(seeded[0]?.outcome).toBe('APPLIED');
  let catalogCalls = 0;
  let beforeCatalogResponse: Effect.Effect<void> = Effect.void;
  const catalogServer = yield* servePurchaseFixtureHttpServer(
    snapshot,
    Effect.gen(function* currentPaymentTerms() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      expect(request.headers.authorization).toBe('Bearer native-retail-catalog');
      const input = yield* request.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CurrentPaymentTermsRequestSchema)),
      );
      catalogCalls += 1;
      yield* beforeCatalogResponse;
      const provenance = {
        actionInvocationId: randomUUID(),
        actorPrincipalId: fixture.manager.principalId,
        at: '2020-01-01T00:00:00.000Z',
        reason: 'Native retail Catalog fixture',
      };
      const definitions = input.references.map(({ paymentTermRef }) =>
        Schema.decodeUnknownSync(PaymentTermDefinitionSchema)({
          code: 'NATIVE_RETAIL',
          compatibilityId: 'immediate.v1',
          created: provenance,
          definitionRevisionId: termId,
          description: 'Native retail Payment Term',
          lifecycle: { effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveTo: null, state: 'ACTIVE' },
          metadataRevision: 1,
          name: 'Immediate',
          paymentTermRef,
          retired: null,
          semanticFingerprint: 'a'.repeat(64),
          semanticRevisionId: termId,
          semantics: { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
          updated: provenance,
        }),
      );
      return yield* HttpServerResponse.json(
        yield* Schema.decodeUnknownEffect(CurrentPaymentTermsResponseSchema)({
          current: definitions,
          effectiveAt: input.at,
          observedAt: input.at,
          referenceOutcomes: definitions.map((definition) => ({
            definition,
            kind: 'USABLE',
            requestedPaymentTermRef: definition.paymentTermRef,
          })),
          truncated: false,
        }),
      );
    }),
  );
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(catalogServer.address)) {
    return yield* Effect.die('No native Payment Term Catalog port');
  }
  const catalogOrigin = new URL(`http://127.0.0.1:${catalogServer.address.port}`);
  const executePreference = (
    change: typeof changeRetailPaymentTermPreferenceAction.descriptor.payloadSchema.Type.change,
    expectedRevision: number,
    selectedProfile = profile.profileRef,
  ) =>
    runAction({
      payload: { change, expectedRevision, profileRef: selectedProfile },
      principal,
      registration: changeRetailPaymentTermPreferenceAction,
      transport: {
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        targetModuleKey: 'commerce.customer-context',
      },
    }).pipe(
      Effect.provideService(PaymentTermCatalogGatewayCredentialService, {
        issue: () =>
          Effect.succeed({ baseUrl: catalogOrigin, credential: Redacted.make('Bearer native-retail-catalog') }),
      }),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({ ONTOS_ACTION_TRANSACTION_IO_GUARD: true }),
          ConfigProvider.fromEnv(),
        ),
      ),
      Effect.provideContext(context),
    );
  const selected = yield* executePreference({ _tag: 'SET_PREFERENCE', effectiveFrom, paymentTermRef: termRef }, 2);
  expect(selected).toMatchObject({ changed: true, state: { revision: 3 } });
  expect(catalogCalls).toBe(1);
  const noOp = yield* executePreference({ _tag: 'SET_PREFERENCE', effectiveFrom, paymentTermRef: termRef }, 3);
  expect(noOp.changed).toBe(false);
  expect(catalogCalls).toBe(1);
  const foreignPreference = yield* executePreference(
    { _tag: 'SET_PREFERENCE', effectiveFrom, paymentTermRef: termRef },
    3,
    {
      ...profile.profileRef,
      resourceId: Schema.decodeSync(ProfileResultSchema.fields.payload.fields.profileRef.fields.resourceId)(
        randomUUID(),
      ),
    },
  ).pipe(Effect.result);
  expect(Result.isFailure(foreignPreference)).toBe(true);
  expect(catalogCalls).toBe(1);
  beforeCatalogResponse = Effect.gen(function* concurrentOwnerChange() {
    beforeCatalogResponse = Effect.void;
    const cleared = yield* executePreference({ _tag: 'CLEAR_PREFERENCE', effectiveAt: effectiveFrom }, 3).pipe(
      Effect.orDie,
    );
    expect(cleared.changed).toBe(true);
  });
  const stale = yield* executePreference(
    { _tag: 'SET_PREFERENCE', effectiveFrom: '2027-02-01T00:00:00.000Z', paymentTermRef: termRef },
    3,
  ).pipe(Effect.result);
  expect(Result.isFailure(stale)).toBe(true);
  if (Result.isFailure(stale)) {
    expect(stale.failure).toMatchObject({ code: 'operation_context_unavailable' });
  }
  expect(catalogCalls).toBe(2);
  const [saved] = yield* admin.execute<{ readonly count: number }>(
    sql`select count(*)::integer as count from commerce_customer_context.saved_addresses where saved_address_id=${produced.address.savedAddressRef.resourceId}::uuid and tenant_id=${fixture.tenantId}::uuid`,
    'objects',
  );
  expect(saved?.count).toBe(1);
  yield* fixture
    .prepareOwner(
      (transaction, scope) =>
        Effect.gen(function* genuineProfileAddressOwnership() {
          const [other] = yield* transaction.invoke(ensureProfile, [
            randomUUID(),
            null,
            'AUTHENTICATED',
            prepared.at,
            'AUTHORIZED_ONBOARDING',
            randomUUID(),
            fixture.manager.principalId,
          ]);
          if (other === undefined) {
            return yield* Effect.die('No genuine second profile');
          }
          const otherProfile = {
            ...profile,
            profileRef: { ...profile.profileRef, resourceId: other.payload.profileRef.resourceId },
          };
          expect(otherProfile.profileRef.resourceId).not.toBe(profile.profileRef.resourceId);
          for (const ports of [
            invoiceRecipientPortsForTransaction(transaction, scope),
            deliveryDestinationPortsForTransaction(transaction, scope),
          ]) {
            const own = yield* ports.loadSavedAddress({
              profile,
              resourceId: produced.address.savedAddressRef.resourceId,
            });
            expect(own).toMatchObject({
              kind: 'FOUND',
              value: { profile, savedAddressRef: produced.address.savedAddressRef },
            });
            const foreign = yield* ports.loadSavedAddress({
              profile: otherProfile,
              resourceId: produced.address.savedAddressRef.resourceId,
            });
            expect(foreign).toEqual({ kind: 'NOT_FOUND' });
          }
          return yield* Effect.void;
        }),
      'required',
    )
    .pipe(Effect.provideContext(context));
  const pair = yield* Effect.promise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
  const publicJwk = yield* Effect.promise(() => exportJWK(pair.publicKey));
  const issuer = 'https://native-purchase-plan.ontos.test';
  const source = catalogServer;
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(source.address)) {
    return yield* Effect.die('No composition TCP address');
  }
  const environment = {
    ...fixture.permissionEnvironment,
    APP_ENV_PATH: '/dev/null',
    DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
    DATABASE_URL: isolated.connections.runtime.connectionString,
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${source.address.port}/active-composition`,
    ONTOS_GATEWAY_ISSUER: issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
      keys: [{ ...publicJwk, alg: 'EdDSA', kid: 'purchase-plan', use: 'sig' }],
    }),
    SPICEDB_PRESHARED_KEY: Redacted.value(fixture.permissionEnvironment.SPICEDB_PRESHARED_KEY),
  };
  const child = yield* ChildProcess.make(process.execPath, [artifact], {
    cwd: appRoot,
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  // Keep draining both pipes after readiness: the governed-read failure tag and reason are
  // logged by the real receiver rather than exposed in its intentionally generic HTTP problem.
  let receiverDiagnostics = '';
  const appendDiagnostic = (line: string) => {
    receiverDiagnostics = `${receiverDiagnostics}${line}\n`.slice(-32_768);
  };
  const readyLine = yield* Deferred.make<string, Error>();
  let awaitingReady = true;
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      if (awaitingReady) {
        awaitingReady = false;
        return Deferred.succeed(readyLine, line).pipe(Effect.asVoid);
      }
      return Effect.sync(() => appendDiagnostic(line));
    }),
    Effect.ensuring(
      Deferred.fail(readyLine, new Error('Default purchase receiver closed before readiness')).pipe(Effect.asVoid),
    ),
    Effect.forkScoped,
  );
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Effect.sync(() => appendDiagnostic(line))),
    Effect.forkScoped,
  );
  const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiverReadySchema))(
    yield* Deferred.await(readyLine),
  );
  expect(ready.marker).toEqual(marker);
  const baseUrl = `http://127.0.0.1:${ready.port}`;
  const purchasingContext = {
    cartId: 'native-cart',
    channelId: 'web',
    expectedProposalRevision: 1,
    expectedSourceRevisions: [{ revision: '1', source: 'cart' }],
    marketId: 'cz',
    sellingLegalEntityId: fixture.legalEntityId,
    storefrontId: 'native-storefront',
    tenantId: fixture.tenantId,
  };
  const guest = {
    purchasingContext,
    subject: { guestEvidenceRef: 'native-guest-evidence', guestSessionRef: 'native-guest-session', kind: 'GUEST' },
  };
  const withoutAddress = { purchasingContext, subject: { kind: 'PROFILE', profile } };
  const withAddress = {
    ...withoutAddress,
    explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef: produced.address.savedAddressRef },
  };
  const freshAssertion = (actor = principal) =>
    Effect.gen(function* issueFreshPurchaseAssertion() {
      const [clock] = yield* admin.execute<{ readonly epoch: number }>(
        sql`select floor(extract(epoch from clock_timestamp()))::integer as epoch`,
        'objects',
      );
      if (clock === undefined) {
        return yield* Effect.die('No native gateway clock');
      }
      return yield* Effect.promise(() =>
        new SignJWT({
          compositionRevision: snapshot.composition.revision,
          principal: { ...actor, trustedStorefrontId: 'native-storefront' },
          targetBuildMarker: marker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: 'purchase-plan', typ: 'JWT' })
          .setAudience('commerce-customer-context')
          .setIssuer(issuer)
          .setSubject(actor.principalId)
          .setIssuedAt(clock.epoch)
          .setExpirationTime(clock.epoch + GATEWAY_ASSERTION_TTL_SECONDS)
          .setJti(randomUUID())
          .sign(pair.privateKey),
      );
    });
  yield* probeNativeGateway(environment, marker, yield* freshAssertion(), yield* freshAssertion());
  const invoke = (route: string, input: Readonly<object>, actor = principal, receiverUrl = baseUrl) =>
    Effect.gen(function* invokeDefaultPurchaseRead() {
      const assertion = yield* freshAssertion(actor);
      const correlationId = randomUUID();
      const response = yield* Effect.promise(() =>
        fetch(`${receiverUrl}/reads/${route}`, {
          body: JSON.stringify(input),
          headers: {
            authorization: `Bearer ${assertion}`,
            'content-type': 'application/json',
            'x-correlation-id': correlationId,
          },
          method: 'POST',
        }),
      );
      const body = yield* Effect.promise(() => response.json());
      expect(JSON.stringify(body)).not.toContain(produced.address.savedAddressRef.resourceId);
      return { body, correlationId, status: response.status };
    });
  const expectSpicePermissionDenied = (route: string, actor = principal) =>
    Effect.gen(function* assertNativeResourceDenial() {
      const before = yield* fixture.evidence(coreEvidenceExecutor);
      const existingIds = new Set(before.accesses.map(({ dataAccessEventId }) => dataAccessEventId));
      const denied = yield* invoke(route, withAddress, actor);
      expect(
        denied.status,
        `Unexpected ${route} denial response: ${JSON.stringify(denied.body)}\nReceiver output (bounded):\n${receiverDiagnostics}`,
      ).toBe(403);
      const after = yield* fixture.evidence(coreEvidenceExecutor);
      const newAccesses = after.accesses.filter(({ dataAccessEventId }) => !existingIds.has(dataAccessEventId));
      expect(newAccesses).toHaveLength(1);
      expect(newAccesses[0]).toMatchObject({
        evidencePolicyKey: `commerce.customer-context.api.${route}.evidence.v1`,
        legalEntityId: fixture.legalEntityId,
        outcome: 'denied',
        outcomeCode: 'spicedb_permission_denied',
        outcomeStage: 'authz',
        principalId: actor.principalId,
        resultCount: 0,
        servingModuleKey: 'commerce.customer-context',
        tenantId: fixture.tenantId,
      });
    });
  for (const route of ['invoice-recipient-resolution', 'delivery-destination-resolution']) {
    expect(yield* invoke(route, guest)).toMatchObject({ status: 503 });
    expect(yield* invoke(route, withoutAddress)).toMatchObject({ status: 503 });
    yield* expectSpicePermissionDenied(route);
  }
  yield* fixture.grantResourceAccess(produced.address.savedAddressRef, fixture.manager.principalId);
  yield* fixture.grantResourceAccess(produced.address.savedAddressRef, fixture.legalEntityOnly.principalId);
  const invoiceInput = yield* Schema.decodeUnknownEffect(InvoiceRecipientResolutionRequestSchema)(withAddress);
  const invoiceClientFailure = yield* executeInvoiceRecipientResolutionWithAuthorization(
    invoiceInput,
    `Bearer ${yield* freshAssertion()}`,
    randomUUID(),
    { baseUrl, compositionRevision: snapshot.composition.revision },
  ).pipe(Effect.provide(FetchHttpClient.layer), Effect.flip);
  expect(Schema.is(InvoiceRecipientResolutionUnavailableProblemSchema)(invoiceClientFailure)).toBe(true);
  const deliveryInput = yield* Schema.decodeUnknownEffect(DeliveryDestinationResolutionRequestSchema)(withAddress);
  const deliveryClientFailure = yield* executeDeliveryDestinationResolutionWithAuthorization(
    deliveryInput,
    `Bearer ${yield* freshAssertion()}`,
    randomUUID(),
    { baseUrl, compositionRevision: snapshot.composition.revision },
  ).pipe(Effect.provide(FetchHttpClient.layer), Effect.flip);
  expect(Schema.is(DeliveryDestinationResolutionUnavailableProblemSchema)(deliveryClientFailure)).toBe(true);
  for (const route of ['invoice-recipient-resolution', 'delivery-destination-resolution']) {
    const allowed = yield* invoke(route, withAddress);
    expect(allowed).toMatchObject({ status: 503 });
    expect(
      route === 'invoice-recipient-resolution'
        ? Schema.is(InvoiceRecipientResolutionUnavailableProblemSchema)(allowed.body)
        : Schema.is(DeliveryDestinationResolutionUnavailableProblemSchema)(allowed.body),
    ).toBe(true);
    expect(JSON.stringify(allowed.body)).not.toContain('dependency unavailable');
    expect(JSON.stringify(allowed.body)).not.toContain(produced.address.savedAddressRef.resourceId);
    yield* expectSpicePermissionDenied(route, fixture.legalEntityOnly);
    expect(
      yield* invoke(route, {
        ...withAddress,
        purchasingContext: { ...purchasingContext, storefrontId: 'forged-storefront' },
      }),
    ).toMatchObject({ status: 403 });
    expect(
      yield* invoke(route, {
        ...withAddress,
        purchasingContext: { ...purchasingContext, sellingLegalEntityId: randomUUID() },
      }),
    ).toMatchObject({ status: 403 });
    expect(
      yield* invoke(route, { ...withAddress, purchasingContext: { ...purchasingContext, tenantId: randomUUID() } }),
    ).toMatchObject({ status: 400 });
    expect(
      yield* invoke(route, {
        ...withAddress,
        explicitChoice: {
          kind: 'SAVED_ADDRESS',
          savedAddressRef: { ...produced.address.savedAddressRef, tenantId: randomUUID() },
        },
      }),
    ).toMatchObject({ status: 400 });
  }
  const replayToken = yield* freshAssertion();
  const replayRequest = new Request(`${baseUrl}/reads/invoice-recipient-resolution`, {
    body: JSON.stringify(withAddress),
    headers: {
      authorization: `Bearer ${replayToken}`,
      'content-type': 'application/json',
      'x-correlation-id': randomUUID(),
    },
    method: 'POST',
  });
  const firstUse = yield* Effect.promise(() => fetch(replayRequest.clone()));
  expect(firstUse.status).toBe(503);
  const replay = yield* Effect.promise(() => fetch(replayRequest.clone()));
  expect(replay.status).toBe(401);
  expect(JSON.stringify(yield* Effect.promise(() => replay.json()))).not.toContain(
    produced.address.savedAddressRef.resourceId,
  );
  const unavailableChild = yield* ChildProcess.make(process.execPath, [artifact], {
    cwd: appRoot,
    env: { ...environment, SPICEDB_ENDPOINT: 'localhost:1' },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  yield* Stream.runDrain(unavailableChild.stderr).pipe(Effect.forkScoped);
  const unavailableLine = yield* unavailableChild.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
  if (Option.isNone(unavailableLine)) {
    return yield* Effect.die('Unavailable-spice purchase receiver did not start');
  }
  const unavailableReady = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiverReadySchema))(
    unavailableLine.value,
  );
  expect(unavailableReady.marker).toEqual(marker);
  const unavailableUrl = `http://127.0.0.1:${unavailableReady.port}`;
  for (const route of ['invoice-recipient-resolution', 'delivery-destination-resolution']) {
    const unavailable = yield* invoke(route, withAddress, principal, unavailableUrl);
    expect(unavailable).toMatchObject({ status: 503 });
    expect(JSON.stringify(unavailable.body)).not.toContain(produced.address.savedAddressRef.resourceId);
    expect(
      route === 'invoice-recipient-resolution'
        ? Schema.is(InvoiceRecipientResolutionUnavailableProblemSchema)(unavailable.body)
        : Schema.is(DeliveryDestinationResolutionUnavailableProblemSchema)(unavailable.body),
    ).toBe(true);
    expect(JSON.stringify(unavailable.body)).not.toContain('dependency unavailable');
  }
  return yield* Effect.void;
});

it.layer(nativeServices, { excludeTestServices: true })('native purchase permission plans', (suite) => {
  suite.effect(
    'commits the real Saved Address producer and reaches both default receiving owner boundaries',
    () => nativePurchasePermissionPlans,
  );
});
