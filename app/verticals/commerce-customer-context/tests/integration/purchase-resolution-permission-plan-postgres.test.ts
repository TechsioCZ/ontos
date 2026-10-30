import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  ContextAccessLive,
  defineScopedRoutine,
  runAction,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpServer, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

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
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import {
  deliveryDestinationPortsForTransaction,
  invoiceRecipientPortsForTransaction,
} from '../../src/persistence/address-persistence.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

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
      actionKeys: [addSavedAddressAction.descriptor.actionKey],
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
  const source = yield* HttpServer.HttpServer;
  const snapshotDocument = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(snapshot);
  yield* source.serve(Effect.succeed(HttpServerResponse.text(snapshotDocument, { contentType: 'application/json' })));
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
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  const firstLine = yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
  if (Option.isNone(firstLine)) {
    return yield* Effect.die('Default purchase receiver did not start');
  }
  const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiverReadySchema))(firstLine.value);
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
      expect(denied).toMatchObject({ status: 403 });
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
