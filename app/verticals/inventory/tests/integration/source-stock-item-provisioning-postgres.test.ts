import { generateKeyPairSync, sign } from 'node:crypto';

import {
  findPostgresFailure,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { eq } from 'drizzle-orm';
import {
  Array as EffectArray,
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Option,
  Order,
  Redacted,
  Result,
  Schema,
} from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { assert, expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { createStockLocationActionApiLive } from '../../api/create-stock-location-action-server.ts';
import { defineSourceProvisioningPolicyActionApiLive } from '../../api/define-source-provisioning-policy-action-server.ts';
import { provisionSourceStockItemActionApiLive } from '../../api/provision-source-stock-item-action-server.ts';
import { selectInventoryBackendActionApiLive } from '../../api/select-inventory-backend-action-server.ts';
import { sourceStockItemProvisioningReceiptReadApiLive } from '../../api/source-stock-item-provisioning-receipt-read-server.ts';
import { sourceStockPositionResolutionReadApiLive } from '../../api/source-stock-position-resolution-read-server.ts';
import {
  CreateStockLocationPayloadSchema,
  CreateStockLocationResultSchema,
} from '../../shared/actions/create-stock-location.ts';
import {
  DefineSourceProvisioningPolicyPayloadSchema,
  DefineSourceProvisioningPolicyResultSchema,
} from '../../shared/actions/define-source-provisioning-policy.ts';
import {
  ProvisionSourceStockItemPayloadSchema,
  ProvisionSourceStockItemResultSchema,
} from '../../shared/actions/provision-source-stock-item.ts';
import { SelectInventoryBackendPayloadSchema } from '../../shared/actions/select-inventory-backend.ts';
import { inventoryApi } from '../../shared/api.ts';
import { DefineSourceProvisioningPolicyActionIneligibleProblemSchema } from '../../shared/apis/define-source-provisioning-policy-action.ts';
import {
  ProvisionSourceStockItemActionForbiddenProblemSchema,
  ProvisionSourceStockItemActionConflictProblemSchema,
  ProvisionSourceStockItemActionIneligibleProblemSchema,
  ProvisionSourceStockItemActionCommitIndeterminateProblemSchema,
} from '../../shared/apis/provision-source-stock-item-action.ts';
import {
  SourceStockPositionResolutionRequestSchema,
  SourceStockPositionResolutionResponseSchema,
} from '../../shared/apis/source-stock-position-resolution.ts';
import { ExternalStockKeySchema } from '../../shared/domain/external-stock-correlation.ts';
import { SourceStockItemProvisioningReceiptResponseSchema } from '../../shared/apis/source-stock-item-provisioning-receipt.ts';
import { SourceStockItemProvisioningInvocationIdSchema } from '../../shared/domain/source-provisioning.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createStockLocationAction } from '../../src/actions/create-stock-location.action.ts';
import { defineSourceProvisioningPolicyAction } from '../../src/actions/define-source-provisioning-policy.action.ts';
import { provisionSourceStockItemAction } from '../../src/actions/provision-source-stock-item.action.ts';
import { selectInventoryBackendAction } from '../../src/actions/select-inventory-backend.action.ts';
import { executeCreateStockLocationWithAuthorization } from '../../src/api/create-stock-location-action-client.ts';
import { executeDefineSourceProvisioningPolicyWithAuthorization } from '../../src/api/define-source-provisioning-policy-action-client.ts';
import { executeProvisionSourceStockItemWithAuthorization } from '../../src/api/provision-source-stock-item-action-client.ts';
import { executeSelectInventoryBackendWithAuthorization } from '../../src/api/select-inventory-backend-action-client.ts';
import { executeSourceStockItemProvisioningReceiptWithAuthorization } from '../../src/api/source-stock-item-provisioning-receipt-client.ts';
import { executeSourceStockPositionResolutionWithAuthorization } from '../../src/api/source-stock-position-resolution-client.ts';
import {
  inventoryCatalogToStockBindings,
  inventoryExternalStockCorrelations,
  inventoryStockItems,
  inventoryStockPositions,
  inventorySourceProvisioningPolicies,
  inventorySourceProvisioningPolicyLocations,
  inventorySourceStockItemProvisionings,
} from '../../src/database/schema.ts';
import { externalStockCorrelationPersistenceForScope } from '../../src/persistence/external-stock-correlation-repository.ts';
import { importSourceAssertionOwnerAuthorizationOverlayLive } from '../../src/persistence/import-source-assertion-owner-authorization.ts';
import { inventoryRegistration } from '../../vertical.registration.ts';
import { requireExecutionResult } from '../support/action-execution-result.ts';
import { sourceImportCompositionFixture } from '../support/source-import-composition.fixture.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());

/** Catalog-owned inputs this Inventory test does not run Catalog for; Inventory retains them as given. */
const CATALOG_PRODUCT_UNIT_ID = 'c47a1001-0000-4000-8000-000000000011';
const CATALOG_PRODUCT_ID = 'c47a1001-0000-4000-8000-000000000012';
const CATALOG_VARIANT_ID = 'c47a1001-0000-4000-8000-000000000013';

/**
 * One staff Action defines the backend's provisioning policy once; one replay-safe Action then provisions an ERP
 * item into it, replacing the four per-item operator Actions. Provisioning twice yields the same refs and exactly
 * one Position per allowed location; the read finds the Position from the ERP keys; an unknown location is
 * refused. Every call runs under a staff token, not under a registered workload.
 */
it.live('provisions one ERP item once, adopts it on every repeat, and resolves its Position by ERP keys', () =>
  Effect.gen(function* sourceStockItemProvisioning() {
    const composition = yield* sourceImportCompositionFixture;
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: composition,
      mode: 'schema-only',
      purpose: 'implementation-1134-inventory-source-import-receipt',
    });
    const { connections } = isolated;
    const now = Math.floor(DateTime.toEpochMillis(composition.observedAt) / 1000);
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        access: 'allowed',
        actionKeys: [
          selectInventoryBackendAction.descriptor.actionKey,
          createStockLocationAction.descriptor.actionKey,
          defineSourceProvisioningPolicyAction.descriptor.actionKey,
          provisionSourceStockItemAction.descriptor.actionKey,
        ],
        adminConnectionString: Redacted.make(connections.admin.connectionString),
        allowedAudiences: ['inventory'],
        applicationComposition: makeActiveApplicationCompositionService(Effect.succeed(composition)),
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision: composition.composition.revision,
        expectedDeployment: ultramodernApiMarker,
        moduleKeys: ['commerce.inventory'],
        ownerRegistration: inventoryRegistration,
        runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
      }),
      (value) => value.close().pipe(Effect.orDie),
    );
    const ownerRuntimeLayer = fixture.layer.pipe(Layer.provide(importSourceAssertionOwnerAuthorizationOverlayLive));
    const { tenantId } = fixture;

    const keyPair = yield* Effect.sync(() => generateKeyPairSync('ed25519'));
    const kid = 'inventory-source-provisioning';
    const tokenIssuer = 'https://disposable-shell.ontos.test';
    const jwks = JSON.stringify({
      keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
    });
    const authorization = Effect.fn('SourceProvisioningTest.authorization')(function* authorization(
      withLegalEntity = false,
    ) {
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          aud: 'inventory',
          compositionRevision: composition.composition.revision,
          exp: now + 300,
          iat: now,
          iss: tokenIssuer,
          jti: yield* nextId,
          principal:
            withLegalEntity === true ? { ...fixture.manager, legalEntityId: fixture.legalEntityId } : fixture.manager,
          sub: fixture.manager.principalId,
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        }),
      ).toString('base64url');
      const content = `${header}.${payload}`;
      return `Bearer ${content}.${sign(null, Buffer.from(content), keyPair.privateKey).toString('base64url')}`;
    });
    // Inventory's production default is still unconfigured. This test substitutes only redemption storage.
    const redeemed = new Set<string>();
    const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
      consume: ({ jti }) =>
        Effect.suspend(() => {
          if (redeemed.has(jti)) {
            return Effect.fail(new GatewayAssertionReplayError({ reason: 'Bearer assertion was already redeemed' }));
          }
          redeemed.add(jti);
          return Effect.void;
        }),
    });
    const api = HttpApi.make('InventoryApi')
      .add(inventoryApi.groups.selectInventoryBackendAction)
      .add(inventoryApi.groups.createStockLocationAction)
      .add(inventoryApi.groups.defineSourceProvisioningPolicyAction)
      .add(inventoryApi.groups.provisionSourceStockItemAction)
      .add(inventoryApi.groups.sourceStockItemProvisioningReceipt)
      .add(inventoryApi.groups.sourceStockPositionResolution);
    const handlers = Layer.mergeAll(
      selectInventoryBackendActionApiLive,
      createStockLocationActionApiLive,
      defineSourceProvisioningPolicyActionApiLive,
      provisionSourceStockItemActionApiLive,
      sourceStockItemProvisioningReceiptReadApiLive,
      sourceStockPositionResolutionReadApiLive,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          ActionPrincipalVerifierLive,
          makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
        ).pipe(Layer.provide(ActiveApplicationCompositionSourceLive), Layer.provide(FetchHttpClient.layer)),
      ),
      Layer.provide(redemption),
      Layer.provide(ownerRuntimeLayer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ ONTOS_GATEWAY_ISSUER: tokenIssuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks }),
        ),
      ),
    );
    const app = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(handlers),
            Layer.provideMerge(ownerRuntimeLayer),
            Layer.provide(HttpServer.layerServices),
            Layer.provide(NodeCrypto.layer),
          ),
          { disableLogger: true },
        ),
      ),
      (value) => Effect.promise(value.dispose.bind(value)).pipe(Effect.orDie),
    );
    const nativeFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), emptyContext);
    const options = Effect.fn('SourceProvisioningTest.options')(function* options() {
      return {
        baseUrl: 'https://inventory.ontos.test',
        compositionRevision: composition.composition.revision,
        idempotencyKey: yield* nextId,
      };
    });
    const run = <Result, Failure, Requirements>(effect: Effect.Effect<Result, Failure, Requirements>) =>
      effect.pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));

    // The Customer Configuration selects the customer's ERP as its one Inventory Backend.
    const customerConfigurationId = `source-provisioning-${yield* nextId}`;
    const issuer = { backendId: 'erp-source-provisioning', backendKind: 'external_business_system' } as const;
    const selected = yield* run(
      executeSelectInventoryBackendWithAuthorization(
        yield* Schema.decodeUnknownEffect(SelectInventoryBackendPayloadSchema)({
          authorizationTargetRef: {
            moduleId: 'commerce.inventory',
            resourceId: yield* nextId,
            resourceType: 'commerce.inventory.inventory-backend-configuration',
            tenantId,
          },
          customerConfigurationId,
          selection: {
            backend: issuer.backendKind,
            backendId: issuer.backendId,
            exactReservationCapability: 'UNSUPPORTED',
            stockCorrectionCapability: 'UNSUPPORTED',
          },
        }),
        yield* authorization(),
        yield* nextId,
        yield* options(),
      ),
    );
    assert('outcome' in selected && selected.outcome === 'SELECTED');
    const { configuration } = selected;
    const createLocation = Effect.fn('SourceProvisioningTest.createLocation')(function* createLocation(
      displayName: string,
    ) {
      const { stockLocation } = yield* run(
        requireExecutionResult(
          CreateStockLocationResultSchema,
          executeCreateStockLocationWithAuthorization(
            yield* Schema.decodeUnknownEffect(CreateStockLocationPayloadSchema)({
              displayName,
              operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: [`erp-site:${displayName}`] },
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
      return stockLocation;
    });
    const warehouse = yield* createLocation('ERP main warehouse');
    const outlet = yield* createLocation('ERP outlet');
    const unitRef = {
      moduleId: 'commerce.catalog',
      resourceId: CATALOG_PRODUCT_UNIT_ID,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    } as const;
    const ownerConfigurationRef = {
      moduleId: 'commerce.inventory',
      resourceId: configuration.configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    } as const;
    const definePolicy = Effect.fn('SourceProvisioningTest.definePolicy')(function* definePolicy(
      locations: readonly { readonly locationKey: string; readonly stockLocationRef: unknown }[],
    ) {
      return yield* run(
        requireExecutionResult(
          DefineSourceProvisioningPolicyResultSchema,
          executeDefineSourceProvisioningPolicyWithAuthorization(
            yield* Schema.decodeUnknownEffect(DefineSourceProvisioningPolicyPayloadSchema)({
              customerConfigurationId,
              externalScope: 'erp-company:main',
              locations,
              namespace: 'erp-stock',
              ownerConfigurationRef,
              unitRef,
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
    });

    // An unknown Stock Location is refused, and nothing is stored for the backend.
    const unknownLocation = yield* definePolicy([
      { locationKey: 'WH-MAIN', stockLocationRef: warehouse.ref },
      {
        locationKey: 'WH-UNKNOWN',
        stockLocationRef: { ...warehouse.ref, resourceId: yield* nextId },
      },
    ]).pipe(Effect.flip);
    assert(Schema.is(DefineSourceProvisioningPolicyActionIneligibleProblemSchema)(unknownLocation));
    expect(unknownLocation.reason).toBe('STOCK_LOCATION_NOT_FOUND');

    // The one-time policy: two allowed locations with their ERP keys.
    const locations = [
      { locationKey: 'WH-MAIN', stockLocationRef: warehouse.ref },
      { locationKey: 'WH-OUTLET', stockLocationRef: outlet.ref },
    ];
    const policyRace = yield* Effect.all([definePolicy(locations), definePolicy(locations)], { concurrency: 2 });
    expect(
      EffectArray.sort(
        policyRace.map(({ outcome }) => outcome),
        Order.String,
      ),
    ).toEqual(['DEFINED', 'EXACT_REPLAY']);
    const [defined] = policyRace;
    assert(defined !== undefined);
    expect(yield* definePolicy(EffectArray.reverse(locations))).toEqual({
      outcome: 'EXACT_REPLAY',
      policy: defined.policy,
    });

    // One ERP item, provisioned twice under two idempotency keys.
    const input = yield* Schema.decodeUnknownEffect(ProvisionSourceStockItemPayloadSchema)({
      catalogSelection: {
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: CATALOG_PRODUCT_ID,
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: CATALOG_VARIANT_ID,
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      },
      exactSelectionMeaning: { id: `catalog-variant:${CATALOG_VARIANT_ID}`, kind: 'PRODUCT_VARIANT' },
      itemKey: 'SKU-1',
      policyRef: defined.policy.policyRef,
    });
    const provision = Effect.fn('SourceProvisioningTest.provision')(function* provision(
      candidate = input,
      key?: string,
    ) {
      const executionOptions = yield* options();
      return yield* run(
        requireExecutionResult(
          ProvisionSourceStockItemResultSchema,
          executeProvisionSourceStockItemWithAuthorization(
            candidate,
            yield* authorization(),
            yield* nextId,
            key === undefined ? executionOptions : { ...executionOptions, idempotencyKey: key },
          ),
        ),
      );
    });
    const keys = [yield* nextId, yield* nextId];
    const race = yield* Effect.all(
      keys.map((key) => provision(input, key)),
      { concurrency: 2 },
    );
    const firstIndex = race.findIndex(({ stockItem }) => stockItem.disposition === 'ESTABLISHED');
    const first = race[firstIndex];
    const second = race[1 - firstIndex];
    assert(first !== undefined && second !== undefined);
    expect(yield* provision(input, keys[firstIndex])).toEqual(first);
    const divergentInvocation = yield* provision(
      {
        ...input,
        itemKey: Schema.decodeUnknownSync(ProvisionSourceStockItemPayloadSchema.fields.itemKey)('SKU-OTHER'),
      },
      keys[firstIndex],
    ).pipe(Effect.flip);
    assert(Schema.is(ProvisionSourceStockItemActionConflictProblemSchema)(divergentInvocation));
    expect(divergentInvocation.code).toBe('action_request_hash_conflict');
    expect(first.stockItem.disposition).toBe('ESTABLISHED');
    expect(first.positions.map(({ disposition, locationKey }) => [locationKey, disposition])).toEqual([
      ['WH-MAIN', 'ESTABLISHED'],
      ['WH-OUTLET', 'ESTABLISHED'],
    ]);
    expect(second.stockItem.ref).toEqual(first.stockItem.ref);
    expect(second.binding.ref).toEqual(first.binding.ref);
    expect(second.itemCorrelation.ref).toEqual(first.itemCorrelation.ref);
    expect(second.positions.map(({ positionRef }) => positionRef)).toEqual(
      first.positions.map(({ positionRef }) => positionRef),
    );
    expect(
      [second.stockItem, second.binding, second.itemCorrelation, ...second.positions].every(
        ({ disposition }) => disposition === 'ADOPTED',
      ),
    ).toBe(true);

    // The database holds one Item, one binding, one ITEM correlation and exactly one Position per location.
    const stored = yield* fixture
      .prepareOwner((transaction) =>
        Effect.all({
          bindings: transaction
            .select({ id: inventoryCatalogToStockBindings.bindingId })
            .from(inventoryCatalogToStockBindings)
            .where(eq(inventoryCatalogToStockBindings.tenantId, tenantId)),
          correlations: transaction
            .select({ kind: inventoryExternalStockCorrelations.identifierKind })
            .from(inventoryExternalStockCorrelations)
            .where(eq(inventoryExternalStockCorrelations.tenantId, tenantId)),
          items: transaction
            .select({ id: inventoryStockItems.stockItemId })
            .from(inventoryStockItems)
            .where(eq(inventoryStockItems.tenantId, tenantId)),
          positions: transaction
            .select({ location: inventoryStockPositions.stockLocationId })
            .from(inventoryStockPositions)
            .where(eq(inventoryStockPositions.tenantId, tenantId)),
        }),
      )
      .pipe(Effect.provide(ownerRuntimeLayer));
    expect(stored.items).toEqual([{ id: first.stockItem.ref.resourceId }]);
    expect(stored.bindings).toEqual([{ id: first.binding.ref.resourceId }]);
    expect(
      EffectArray.sort(
        stored.correlations.map(({ kind }) => kind),
        Order.String,
      ),
    ).toEqual(['ITEM', 'LOCATION', 'LOCATION']);
    expect(
      EffectArray.sort(
        stored.positions.map(({ location }) => location),
        Order.String,
      ),
    ).toEqual(EffectArray.sort([warehouse.ref.resourceId, outlet.ref.resourceId], Order.String));

    const observe = () =>
      fixture
        .prepareOwner((transaction) =>
          Effect.all({
            allowed: transaction
              .select()
              .from(inventorySourceProvisioningPolicyLocations)
              .orderBy(inventorySourceProvisioningPolicyLocations.locationKey),
            bindings: transaction
              .select()
              .from(inventoryCatalogToStockBindings)
              .orderBy(inventoryCatalogToStockBindings.bindingId),
            correlations: transaction
              .select()
              .from(inventoryExternalStockCorrelations)
              .orderBy(inventoryExternalStockCorrelations.correlationId),
            items: transaction.select().from(inventoryStockItems).orderBy(inventoryStockItems.stockItemId),
            policies: transaction
              .select()
              .from(inventorySourceProvisioningPolicies)
              .orderBy(inventorySourceProvisioningPolicies.policyId),
            positions: transaction
              .select()
              .from(inventoryStockPositions)
              .orderBy(inventoryStockPositions.stockPositionId),
            receipts: transaction
              .select()
              .from(inventorySourceStockItemProvisionings)
              .orderBy(inventorySourceStockItemProvisionings.actionInvocationId),
          }),
        )
        .pipe(Effect.provide(ownerRuntimeLayer));
    const baseline = yield* observe();
    const conflictingMeaning = yield* Schema.decodeUnknownEffect(ProvisionSourceStockItemPayloadSchema)({
      ...input,
      catalogSelection: {
        ...input.catalogSelection,
        variantRef: { ...input.catalogSelection.variantRef, resourceId: yield* nextId },
      },
      exactSelectionMeaning: { id: `catalog-variant:${yield* nextId}`, kind: 'PRODUCT_VARIANT' },
    });
    // Conflict occurs after candidate Item and Positions were written; all of them must roll back.
    const divergence = yield* provision(conflictingMeaning).pipe(Effect.flip);
    assert(Schema.is(ProvisionSourceStockItemActionIneligibleProblemSchema)(divergence));
    expect(divergence.reason).toBe('ITEM_CORRELATION_CONFLICT');
    expect(divergence.conflictRef).toEqual(first.itemCorrelation.ref);
    expect(yield* observe()).toEqual(baseline);

    const changedPolicy = yield* definePolicy(locations.slice(0, 1)).pipe(Effect.flip);
    assert(Schema.is(DefineSourceProvisioningPolicyActionIneligibleProblemSchema)(changedPolicy));
    expect(changedPolicy.reason).toBe('POLICY_ALREADY_DEFINED');
    expect(yield* observe()).toEqual(baseline);

    const newSku = yield* Schema.decodeUnknownEffect(ProvisionSourceStockItemPayloadSchema)({
      ...conflictingMeaning,
      itemKey: 'SKU-2',
    });
    const retryKey = yield* nextId;
    fixture.faultNextTransaction('rollback');
    yield* provision(newSku, retryKey).pipe(Effect.flip);
    expect(yield* observe()).toEqual(baseline);
    const committedRetry = yield* provision(newSku, retryKey);
    expect(committedRetry.stockItem.disposition).toBe('ESTABLISHED');

    const beforeDivergentRace = yield* observe();
    const otherMeaning = yield* Schema.decodeUnknownEffect(ProvisionSourceStockItemPayloadSchema)({
      ...newSku,
      catalogSelection: {
        ...newSku.catalogSelection,
        variantRef: { ...newSku.catalogSelection.variantRef, resourceId: yield* nextId },
      },
      exactSelectionMeaning: { id: `catalog-variant:${yield* nextId}`, kind: 'PRODUCT_VARIANT' },
      itemKey: 'SKU-RACE',
    });
    const divergentRace = yield* Effect.all(
      [
        provision(
          yield* Schema.decodeUnknownEffect(ProvisionSourceStockItemPayloadSchema)({ ...newSku, itemKey: 'SKU-RACE' }),
        ).pipe(Effect.result),
        provision(otherMeaning).pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    expect(divergentRace.filter(Result.isSuccess)).toHaveLength(1);
    const rejectedRace = divergentRace.find(Result.isFailure);
    assert(rejectedRace !== undefined && Result.isFailure(rejectedRace));
    assert(Schema.is(ProvisionSourceStockItemActionIneligibleProblemSchema)(rejectedRace.failure));
    expect(rejectedRace.failure.reason).toBe('ITEM_CORRELATION_CONFLICT');
    const raceWinner = divergentRace.find(Result.isSuccess);
    assert(raceWinner !== undefined && Result.isSuccess(raceWinner));
    expect(rejectedRace.failure.conflictRef).toEqual(raceWinner.success.itemCorrelation.ref);
    const afterDivergentRace = yield* observe();
    expect(afterDivergentRace.receipts).toHaveLength(beforeDivergentRace.receipts.length + 1);
    // At most the previously-unseen meaning won; the losing candidate leaves no Item or Positions.
    expect(afterDivergentRace.items.length - beforeDivergentRace.items.length).toBeLessThanOrEqual(1);
    expect(afterDivergentRace.positions.length - beforeDivergentRace.positions.length).toBeLessThanOrEqual(
      locations.length,
    );

    // Trust comes from the operation, never from either payload's Tenant or a claimed allowed location.
    const otherTenant = yield* nextId;
    const crossTenant = yield* Schema.decodeUnknownEffect(ProvisionSourceStockItemPayloadSchema)({
      ...input,
      catalogSelection: {
        productRef: { ...input.catalogSelection.productRef, tenantId: otherTenant },
        variantRef: { ...input.catalogSelection.variantRef, tenantId: otherTenant },
      },
      policyRef: { ...input.policyRef, tenantId: otherTenant },
    });
    const legalEntityRejection = yield* run(
      executeProvisionSourceStockItemWithAuthorization(
        input,
        yield* authorization(true),
        yield* nextId,
        yield* options(),
      ),
    ).pipe(Effect.flip);
    assert(Schema.is(ProvisionSourceStockItemActionForbiddenProblemSchema)(legalEntityRejection));
    const tenantRejection = yield* provision(crossTenant).pipe(Effect.flip);
    assert(Schema.is(ProvisionSourceStockItemActionIneligibleProblemSchema)(tenantRejection));
    expect(tenantRejection.reason).toBe('TENANT_SCOPE_MISMATCH');
    const foreignLocation = yield* definePolicy([
      { locationKey: 'FOREIGN', stockLocationRef: { ...warehouse.ref, tenantId: otherTenant } },
    ]).pipe(Effect.flip);
    assert(Schema.is(DefineSourceProvisioningPolicyActionIneligibleProblemSchema)(foreignLocation));
    expect(foreignLocation.reason).toBe('TENANT_SCOPE_MISMATCH');
    const rlsFailure = yield* fixture
      .prepareOwner((transaction) =>
        transaction.insert(inventorySourceProvisioningPolicyLocations).values({
          locationKey: 'FOREIGN',
          policyId: defined.policy.policyRef.resourceId,
          stockLocationId: warehouse.ref.resourceId,
          tenantId: otherTenant,
        }),
      )
      .pipe(Effect.provide(ownerRuntimeLayer), Effect.flip);
    expect(
      Option.isSome(
        findPostgresFailure(
          rlsFailure,
          ({ code, constraint }) =>
            code === '42501' || (code === '23514' && constraint === 'inventory_source_provisioning_location_ck'),
        ),
      ),
    ).toBe(true);
    const immutableFailure = yield* fixture
      .prepareOwner((transaction) =>
        transaction.update(inventorySourceProvisioningPolicies).set({ externalScope: 'rewritten' }),
      )
      .pipe(Effect.provide(ownerRuntimeLayer), Effect.flip);
    expect(
      Option.isSome(
        findPostgresFailure(
          immutableFailure,
          ({ code, constraint }) => code === '23514' && constraint === 'inventory_source_provisioning_immutable_ck',
        ),
      ),
    ).toBe(true);

    // The stock import finds the Position from the ERP keys alone; an unknown location key is not resolved.
    const resolve = Effect.fn('SourceProvisioningTest.resolve')(function* resolve(locationKey: string) {
      return yield* run(
        executeSourceStockPositionResolutionWithAuthorization(
          yield* Schema.decodeUnknownEffect(SourceStockPositionResolutionRequestSchema)({
            customerConfigurationId,
            externalScope: 'erp-company:main',
            issuer,
            itemKey: 'SKU-1',
            locationKey,
            namespace: 'erp-stock',
          }),
          yield* authorization(),
          yield* nextId,
          { baseUrl: 'https://inventory.ontos.test', compositionRevision: composition.composition.revision },
        ),
      );
    });
    const resolved = yield* resolve('WH-OUTLET');
    assert(Schema.is(SourceStockPositionResolutionResponseSchema.members[0])(resolved));
    expect(resolved).toMatchObject({
      policyRef: defined.policy.policyRef,
      positionRef: first.positions.find(({ locationKey }) => locationKey === 'WH-OUTLET')?.positionRef,
      stockItemRef: first.stockItem.ref,
      stockLocationRef: outlet.ref,
    });
    const unknownLocationResolution = yield* resolve('WH-NOWHERE');
    assert(Schema.is(SourceStockPositionResolutionResponseSchema.members[1])(unknownLocationResolution));
    expect(unknownLocationResolution.reason).toBe('LOCATION_NOT_ALLOWED');

    // A lost acknowledgement is recovered by the original invocation id through the receipt read.
    fixture.faultNextTransaction('lost-ack');
    const lost = yield* provision().pipe(Effect.flip);
    assert(Schema.is(ProvisionSourceStockItemActionCommitIndeterminateProblemSchema)(lost));
    const receipt = yield* run(
      executeSourceStockItemProvisioningReceiptWithAuthorization(
        { actionInvocationId: SourceStockItemProvisioningInvocationIdSchema.make(lost.invocationId), input },
        yield* authorization(),
        yield* nextId,
        { baseUrl: 'https://inventory.ontos.test', compositionRevision: composition.composition.revision },
      ),
    );
    assert(Schema.is(SourceStockItemProvisioningReceiptResponseSchema.members[0])(receipt));
    expect(receipt.receipt.provisioning.stockItem.ref).toEqual(first.stockItem.ref);
    expect(receipt.receipt.provisioning.positions.map(({ positionRef }) => positionRef)).toEqual(
      first.positions.map(({ positionRef }) => positionRef),
    );
    const endCorrelation = (identifierKind: 'ITEM' | 'LOCATION', externalValue: string) =>
      fixture
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* revokeCorrelation() {
            const persistence = externalStockCorrelationPersistenceForScope(transaction, scope);
            const key = yield* Schema.decodeUnknownEffect(ExternalStockKeySchema)({
              customerConfigurationId,
              externalScope: 'erp-company:main',
              externalValue,
              identifierKind,
              issuer,
              namespace: 'erp-stock',
              tenantId,
            });
            const endedAt = DateTime.formatIso(yield* DateTime.now.pipe(TestClock.withLive));
            const [current] = yield* persistence.findEffective(key, endedAt);
            assert(current !== undefined);
            yield* persistence.endCurrent({ current, endedAt });
          }),
        )
        .pipe(Effect.provide(ownerRuntimeLayer));
    // Historical correlations still cover policy.effectiveFrom. A current-time lookup must not return them.
    yield* endCorrelation('ITEM', 'SKU-1');
    const revokedItemResolution = yield* resolve('WH-OUTLET');
    assert(Schema.is(SourceStockPositionResolutionResponseSchema.members[1])(revokedItemResolution));
    expect(revokedItemResolution.reason).toBe('ITEM_NOT_PROVISIONED');
    yield* endCorrelation('LOCATION', 'WH-OUTLET');
    const revokedLocationResolution = yield* resolve('WH-OUTLET');
    assert(Schema.is(SourceStockPositionResolutionResponseSchema.members[1])(revokedLocationResolution));
    expect(revokedLocationResolution.reason).toBe('LOCATION_NOT_ALLOWED');
    const beforeRevokedProvision = yield* observe();
    const revokedProvision = yield* provision(newSku).pipe(Effect.flip);
    assert(Schema.is(ProvisionSourceStockItemActionIneligibleProblemSchema)(revokedProvision));
    expect(revokedProvision.reason).toBe('STOCK_LOCATION_NOT_ACTIVE');
    expect(yield* observe()).toEqual(beforeRevokedProvision);
    // Receipt history remains recoverable even after correlation revocation; reads never recreate authority.
    const historicalReceipt = yield* run(
      executeSourceStockItemProvisioningReceiptWithAuthorization(
        { actionInvocationId: SourceStockItemProvisioningInvocationIdSchema.make(lost.invocationId), input },
        yield* authorization(),
        yield* nextId,
        { baseUrl: 'https://inventory.ontos.test', compositionRevision: composition.composition.revision },
      ),
    );
    expect(historicalReceipt).toEqual(receipt);
  }).pipe(Effect.provide(NodeCrypto.layer), Effect.provide(NodeServices.layer)),
);
