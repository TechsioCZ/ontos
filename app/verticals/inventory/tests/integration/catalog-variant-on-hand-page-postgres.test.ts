import { generateKeyPairSync, sign } from 'node:crypto';

import {
  CorePersistenceLive,
  DatabaseConfig,
  DatabaseIdentityEnrollmentContext,
  defineDatabaseIdentityEnrollment,
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  makeActiveApplicationCompositionService,
  parseDatabaseConfig,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeCoreDatabase } from '@app/core-runtime/db/client';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { sql } from 'drizzle-orm';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';

import { principals } from '../../../../packages/core-runtime/src/db/schema.ts';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { catalogVariantOnHandPageReadApiLive } from '../../api/catalog-variant-on-hand-page-read-server.ts';
import { createStockLocationActionApiLive } from '../../api/create-stock-location-action-server.ts';
import { establishCatalogToStockBindingActionApiLive } from '../../api/establish-catalog-to-stock-binding-action-server.ts';
import { establishExternalStockCorrelationActionApiLive } from '../../api/establish-external-stock-correlation-action-server.ts';
import { establishStockPositionActionApiLive } from '../../api/establish-stock-position-action-server.ts';
import { importSourceAssertionActionApiLive } from '../../api/import-source-assertion-action-server.ts';
import { registerStockItemActionApiLive } from '../../api/register-stock-item-action-server.ts';
import { selectInventoryBackendActionApiLive } from '../../api/select-inventory-backend-action-server.ts';
import {
  CreateStockLocationPayloadSchema,
  CreateStockLocationResultSchema,
} from '../../shared/actions/create-stock-location.ts';
import {
  EstablishCatalogToStockBindingPayloadSchema,
  EstablishCatalogToStockBindingResultSchema,
} from '../../shared/actions/establish-catalog-to-stock-binding.ts';
import {
  EstablishExternalStockCorrelationPayloadSchema,
  EstablishExternalStockCorrelationResultSchema,
} from '../../shared/actions/establish-external-stock-correlation.ts';
import {
  EstablishStockPositionPayloadSchema,
  EstablishStockPositionResultSchema,
} from '../../shared/actions/establish-stock-position.ts';
import { ImportSourceAssertionResultSchema } from '../../shared/actions/import-source-assertion.ts';
import {
  RegisterStockItemPayloadSchema,
  RegisterStockItemResultSchema,
} from '../../shared/actions/register-stock-item.ts';
import { SelectInventoryBackendPayloadSchema } from '../../shared/actions/select-inventory-backend.ts';
import { inventoryApi } from '../../shared/api.ts';
import {
  CatalogVariantOnHandPageNotFoundProblemSchema,
  CatalogVariantOnHandPageRequestSchema,
} from '../../shared/apis/catalog-variant-on-hand-page.ts';
import { InventorySourceAssertionProposalSchema } from '../../shared/domain/inventory-source-assertion.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createStockLocationAction } from '../../src/actions/create-stock-location.action.ts';
import { establishCatalogToStockBindingAction } from '../../src/actions/establish-catalog-to-stock-binding.action.ts';
import { establishExternalStockCorrelationAction } from '../../src/actions/establish-external-stock-correlation.action.ts';
import { establishStockPositionAction } from '../../src/actions/establish-stock-position.action.ts';
import { importSourceAssertionAction } from '../../src/actions/import-source-assertion.action.ts';
import { registerStockItemAction } from '../../src/actions/register-stock-item.action.ts';
import { selectInventoryBackendAction } from '../../src/actions/select-inventory-backend.action.ts';
import { catalogVariantOnHandPageRead } from '../../src/api/catalog-variant-on-hand-page.read.ts';
import { executeCatalogVariantOnHandPageWithAuthorization } from '../../src/api/catalog-variant-on-hand-page-client.ts';
import { executeCreateStockLocationWithAuthorization } from '../../src/api/create-stock-location-action-client.ts';
import { executeEstablishCatalogToStockBindingWithAuthorization } from '../../src/api/establish-catalog-to-stock-binding-action-client.ts';
import { executeEstablishExternalStockCorrelationWithAuthorization } from '../../src/api/establish-external-stock-correlation-action-client.ts';
import { executeEstablishStockPositionWithAuthorization } from '../../src/api/establish-stock-position-action-client.ts';
import { executeImportSourceAssertionWithAuthorization } from '../../src/api/import-source-assertion-action-client.ts';
import { executeRegisterStockItemWithAuthorization } from '../../src/api/register-stock-item-action-client.ts';
import { executeSelectInventoryBackendWithAuthorization } from '../../src/api/select-inventory-backend-action-client.ts';
import { importSourceAssertionOwnerAuthorizationOverlayLive } from '../../src/persistence/import-source-assertion-owner-authorization.ts';
import { inventoryRegistration } from '../../vertical.registration.ts';
import { requireExecutionResult } from '../support/action-execution-result.ts';
import { sourceImportCompositionFixture } from '../support/source-import-composition.fixture.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());

/**
 * Catalog-owned inputs. This Inventory test does not run Catalog: these stand for the Product, the Variants and the
 * Product Unit Catalog owns, which Inventory retains without interpreting them.
 */
const CATALOG_PRODUCT_ID = 'c47a2001-0000-4000-8000-000000000001';
const CATALOG_PRODUCT_UNIT_ID = 'c47a2001-0000-4000-8000-000000000002';
/** V1 has a figure at two Locations, V2 no Stock Item, V3 a Stock Item without a Position, V4 a Position still UNKNOWN. */
const VARIANT_IDS = [
  'c47a2001-0000-4000-8000-000000000011',
  'c47a2001-0000-4000-8000-000000000012',
  'c47a2001-0000-4000-8000-000000000013',
  'c47a2001-0000-4000-8000-000000000014',
] as const;
const READ_KEY = catalogVariantOnHandPageRead.descriptor.accessDeclaration?.key;
const STOREFRONT_WORKLOAD = 'commerce.storefront-client';

/**
 * The read over the state a Symmy stock import really leaves: every owner row is written by the governed Inventory
 * Actions an operator and the Symmy stock route invoke, never inserted by the test. The page's outcomes run through
 * the generated HTTP transport; who may read it is decided by Core's production gate over the same database.
 */
it.live('a page of Catalog Variants shows the accepted ERP figures of its own Customer Configuration only', () =>
  Effect.gen(function* catalogVariantOnHandPage() {
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
          registerStockItemAction.descriptor.actionKey,
          establishCatalogToStockBindingAction.descriptor.actionKey,
          createStockLocationAction.descriptor.actionKey,
          establishStockPositionAction.descriptor.actionKey,
          establishExternalStockCorrelationAction.descriptor.actionKey,
          importSourceAssertionAction.descriptor.actionKey,
        ],
        additionalLegalEntity: 'same-tenant',
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
    const secondCompanyId = fixture.secondaryLegalEntity?.legalEntityId;
    assert(secondCompanyId !== undefined);

    const keyPair = yield* Effect.sync(() => generateKeyPairSync('ed25519'));
    const kid = 'inventory-catalog-variant-on-hand-page';
    const tokenIssuer = 'https://disposable-shell.ontos.test';
    const jwks = JSON.stringify({
      keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
    });
    /** The operator's staff assertion, in the tenant context or, for the company-scoped read, in its company. */
    const authorization = Effect.fn('CatalogVariantOnHandPageTest.authorization')(function* authorization(
      legalEntityId?: string,
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
          principal: legalEntityId === undefined ? fixture.manager : { ...fixture.manager, legalEntityId },
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
      .add(inventoryApi.groups.registerStockItemAction)
      .add(inventoryApi.groups.establishCatalogToStockBindingAction)
      .add(inventoryApi.groups.createStockLocationAction)
      .add(inventoryApi.groups.establishStockPositionAction)
      .add(inventoryApi.groups.establishExternalStockCorrelationAction)
      .add(inventoryApi.groups.importSourceAssertionAction)
      .add(inventoryApi.groups.catalogVariantOnHandPage);
    const handlers = Layer.mergeAll(
      selectInventoryBackendActionApiLive,
      registerStockItemActionApiLive,
      establishCatalogToStockBindingActionApiLive,
      createStockLocationActionApiLive,
      establishStockPositionActionApiLive,
      establishExternalStockCorrelationActionApiLive,
      importSourceAssertionActionApiLive,
      catalogVariantOnHandPageReadApiLive,
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
    const options = Effect.fn('CatalogVariantOnHandPageTest.options')(function* options() {
      return {
        baseUrl: 'https://inventory.ontos.test',
        compositionRevision: composition.composition.revision,
        idempotencyKey: yield* nextId,
      };
    });
    const run = <Result, Failure, Requirements>(effect: Effect.Effect<Result, Failure, Requirements>) =>
      effect.pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));

    const unitRef = {
      moduleId: 'commerce.catalog',
      resourceId: CATALOG_PRODUCT_UNIT_ID,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    } as const;
    const variantRef = (resourceId: string) =>
      ({ moduleId: 'commerce.catalog', resourceId, resourceType: 'commerce.catalog.variant', tenantId }) as const;

    // 1. Two Customer Configurations, each selecting its own ERP as its one Inventory Backend.
    const select = Effect.fn('CatalogVariantOnHandPageTest.select')(function* select(backendId: string) {
      const customerConfigurationId = `on-hand-page-${yield* nextId}`;
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
              backend: 'external_business_system',
              backendId,
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
      return {
        configuration: selected.configuration,
        customerConfigurationId,
        issuer: { backendId, backendKind: 'external_business_system' } as const,
      };
    });
    const shop = yield* select('erp-on-hand-page-shop');
    const otherShop = yield* select('erp-on-hand-page-other-shop');

    // 2. A Stock Item for each of V1, V3 and V4, bound to that Variant itself. V2 is never registered.
    const register = Effect.fn('CatalogVariantOnHandPageTest.register')(function* register(variantId: string) {
      const exactSelectionMeaning = { id: `catalog-variant:${variantId}`, kind: 'PRODUCT_VARIANT' } as const;
      const { stockItem } = yield* run(
        requireExecutionResult(
          RegisterStockItemResultSchema,
          executeRegisterStockItemWithAuthorization(
            yield* Schema.decodeUnknownEffect(RegisterStockItemPayloadSchema)({ exactSelectionMeaning, unitRef }),
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
      yield* run(
        requireExecutionResult(
          EstablishCatalogToStockBindingResultSchema,
          executeEstablishCatalogToStockBindingWithAuthorization(
            yield* Schema.decodeUnknownEffect(EstablishCatalogToStockBindingPayloadSchema)({
              bindingRef: {
                moduleId: 'commerce.inventory',
                resourceId: yield* nextId,
                resourceType: 'commerce.inventory.catalog-to-stock-binding',
                tenantId,
              },
              candidate: {
                catalogSelection: {
                  productRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: CATALOG_PRODUCT_ID,
                    resourceType: 'commerce.catalog.product',
                    tenantId,
                  },
                  variantRef: variantRef(variantId),
                },
                exactSelectionMeaning,
                stockItem,
              },
              evidence: { authority: 'INVENTORY_BINDING_OWNER', ownerEvidenceRef: `operator:bind:${variantId}` },
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
      return stockItem;
    });
    const [v1, , v3, v4] = VARIANT_IDS;
    const item1 = yield* register(v1);
    yield* register(v3);
    const item4 = yield* register(v4);

    // 3. Two ACTIVE Stock Locations for the ERP warehouses.
    const createLocation = Effect.fn('CatalogVariantOnHandPageTest.createLocation')(function* createLocation(
      displayName: string,
      site: string,
    ) {
      const { stockLocation } = yield* run(
        requireExecutionResult(
          CreateStockLocationResultSchema,
          executeCreateStockLocationWithAuthorization(
            yield* Schema.decodeUnknownEffect(CreateStockLocationPayloadSchema)({
              displayName,
              operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: [site] },
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
      return stockLocation;
    });
    const mainWarehouse = yield* createLocation('ERP main warehouse', 'erp-site:main');
    const secondWarehouse = yield* createLocation('ERP second warehouse', 'erp-site:second');

    // 4. Positions start UNKNOWN: V1 at both warehouses and V4 at the main one in the shop; V1 at the main one in the
    // other shop. V3's Stock Item gets none.
    const establish = Effect.fn('CatalogVariantOnHandPageTest.establish')(function* establish(
      configuration: typeof shop,
      stockItemRef: typeof item1.stockItemRef,
      stockLocationRef: typeof mainWarehouse.ref,
    ) {
      const { stockPosition } = yield* run(
        requireExecutionResult(
          EstablishStockPositionResultSchema,
          executeEstablishStockPositionWithAuthorization(
            yield* Schema.decodeUnknownEffect(EstablishStockPositionPayloadSchema)({
              ownerConfigurationRef: {
                moduleId: 'commerce.inventory',
                resourceId: configuration.configuration.configurationId,
                resourceType: 'commerce.inventory.inventory-backend-configuration',
                tenantId,
              },
              scope: {
                customerConfigurationId: configuration.customerConfigurationId,
                stockItemRef,
                stockLocationRef,
                unitRef,
              },
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
      return stockPosition;
    });
    const mainV1 = yield* establish(shop, item1.stockItemRef, mainWarehouse.ref);
    const secondV1 = yield* establish(shop, item1.stockItemRef, secondWarehouse.ref);
    const mainV4 = yield* establish(shop, item4.stockItemRef, mainWarehouse.ref);
    const otherMainV1 = yield* establish(otherShop, item1.stockItemRef, mainWarehouse.ref);

    // 5. Each ERP's own item and location keys, qualified by its Customer Configuration and issuer.
    const externalKey = (configuration: typeof shop, identifierKind: 'ITEM' | 'LOCATION', externalValue: string) => ({
      customerConfigurationId: configuration.customerConfigurationId,
      externalScope: 'erp-company:main',
      externalValue,
      identifierKind,
      issuer: configuration.issuer,
      namespace: 'erp-stock',
      tenantId,
    });
    const correlate = Effect.fn('CatalogVariantOnHandPageTest.correlate')(function* correlate(
      configuration: typeof shop,
      identifierKind: 'ITEM' | 'LOCATION',
      externalValue: string,
      target: { readonly _tag: 'STOCK_ITEM' | 'STOCK_LOCATION'; readonly ref: unknown },
    ) {
      yield* run(
        requireExecutionResult(
          EstablishExternalStockCorrelationResultSchema,
          executeEstablishExternalStockCorrelationWithAuthorization(
            yield* Schema.decodeUnknownEffect(EstablishExternalStockCorrelationPayloadSchema)({
              correlationRef: {
                moduleId: 'commerce.inventory',
                resourceId: yield* nextId,
                resourceType: 'commerce.inventory.external-stock-correlation',
                tenantId,
              },
              effectiveFrom: configuration.configuration.selectedAt,
              externalKey: externalKey(configuration, identifierKind, externalValue),
              ownerEvidenceRef: `erp-stock:${identifierKind}:${externalValue}`,
              target,
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
    });
    yield* correlate(shop, 'ITEM', 'SKU-1', { _tag: 'STOCK_ITEM', ref: item1.stockItemRef });
    yield* correlate(shop, 'ITEM', 'SKU-4', { _tag: 'STOCK_ITEM', ref: item4.stockItemRef });
    yield* correlate(shop, 'LOCATION', 'WH-MAIN', { _tag: 'STOCK_LOCATION', ref: mainWarehouse.ref });
    yield* correlate(shop, 'LOCATION', 'WH-SECOND', { _tag: 'STOCK_LOCATION', ref: secondWarehouse.ref });
    yield* correlate(otherShop, 'ITEM', 'SKU-1', { _tag: 'STOCK_ITEM', ref: item1.stockItemRef });
    yield* correlate(otherShop, 'LOCATION', 'WH-MAIN', { _tag: 'STOCK_LOCATION', ref: mainWarehouse.ref });

    // 6. The owner operation the Symmy stock route enrolls: one absolute ON_HAND row per Position.
    const importFigure = Effect.fn('CatalogVariantOnHandPageTest.importFigure')(function* importFigure(input: {
      readonly amount: string;
      readonly configuration: typeof shop;
      readonly itemKey: string;
      readonly locationKey: string;
      readonly position: typeof mainV1;
      readonly revision: string;
    }) {
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      const proposal = yield* Schema.decodeUnknownEffect(InventorySourceAssertionProposalSchema)({
        assertionId: yield* nextId,
        businessObservedAt: observedAt,
        coverage: [],
        customerConfigurationId: input.configuration.customerConfigurationId,
        factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
        issuer: input.configuration.issuer,
        itemExternalKey: externalKey(input.configuration, 'ITEM', input.itemKey),
        locationExternalKey: externalKey(input.configuration, 'LOCATION', input.locationKey),
        orderingEvidence: { _tag: 'SOURCE_REVISION', revision: input.revision },
        ownerEvidenceRef: `erp-stock:${input.itemKey}:${input.locationKey}:${input.revision}`,
        positionRef: input.position.ref,
        quantity: { amount: input.amount, unitRef },
        receivedAt: observedAt,
        sourceReference: `erp-stock:${input.itemKey}:${input.locationKey}:${input.revision}`,
      });
      const imported = yield* run(
        requireExecutionResult(
          ImportSourceAssertionResultSchema,
          executeImportSourceAssertionWithAuthorization(
            { authorizationTargetRef: input.position.ref, items: [proposal] },
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
      expect(imported.items).toMatchObject([{ status: 'ACCEPTED' }]);
      return observedAt;
    });
    const firstMain = yield* importFigure({
      amount: '12',
      configuration: shop,
      itemKey: 'SKU-1',
      locationKey: 'WH-MAIN',
      position: mainV1,
      revision: '1',
    });
    const second = yield* importFigure({
      amount: '3.5',
      configuration: shop,
      itemKey: 'SKU-1',
      locationKey: 'WH-SECOND',
      position: secondV1,
      revision: '1',
    });
    yield* importFigure({
      amount: '99',
      configuration: otherShop,
      itemKey: 'SKU-1',
      locationKey: 'WH-MAIN',
      position: otherMainV1,
      revision: '1',
    });

    // 7. The read, in the operator's company, exactly as the storefront and the staff list send it.
    const readPage = Effect.fn('CatalogVariantOnHandPageTest.readPage')(function* readPage(
      customerConfigurationId: string,
      variantIds: readonly string[],
    ) {
      return yield* run(
        executeCatalogVariantOnHandPageWithAuthorization(
          yield* Schema.decodeUnknownEffect(CatalogVariantOnHandPageRequestSchema)({
            customerConfigurationId,
            variantRefs: variantIds.map(variantRef),
          }),
          yield* authorization(fixture.legalEntityId),
          yield* nextId,
          { baseUrl: 'https://inventory.ontos.test', compositionRevision: composition.composition.revision },
        ),
      );
    });
    const location = (stockLocation: typeof mainWarehouse) => ({
      displayName: stockLocation.displayName,
      ref: stockLocation.ref,
    });
    const reported = (amount: string, sourceObservedAt: string) => ({
      _tag: 'SOURCE_REPORTED',
      quantity: { amount, unitRef },
      receivedAt: sourceObservedAt,
      sourceObservedAt,
    });
    const page = yield* readPage(shop.customerConfigurationId, VARIANT_IDS);
    expect(page).toMatchObject({
      backend: { backendId: 'erp-on-hand-page-shop', kind: 'external_business_system' },
      customerConfigurationId: shop.customerConfigurationId,
      purpose: 'INFORMATIONAL_DISPLAY',
      sharingEligibility: 'NOT_EVALUATED',
    });
    expect(page.items).toEqual([
      {
        outcome: 'ON_HAND',
        positions: [
          { onHand: reported('12', firstMain), positionRef: mainV1.ref, stockLocation: location(mainWarehouse) },
          { onHand: reported('3.5', second), positionRef: secondV1.ref, stockLocation: location(secondWarehouse) },
        ],
        stockItem: expect.objectContaining({ stockItemRef: item1.stockItemRef, unitRef }),
        total: { amount: '15.5', unitRef },
        variantRef: variantRef(v1),
      },
      { outcome: 'NO_STOCK_ITEM', variantRef: variantRef(VARIANT_IDS[1]) },
      { outcome: 'NO_POSITION', stockItem: expect.objectContaining({ unitRef }), variantRef: variantRef(v3) },
      {
        outcome: 'ON_HAND_UNKNOWN',
        positions: [
          {
            onHand: { _tag: 'NOT_ESTABLISHED', state: 'UNKNOWN' },
            positionRef: mainV4.ref,
            stockLocation: location(mainWarehouse),
          },
        ],
        stockItem: expect.objectContaining({ stockItemRef: item4.stockItemRef }),
        variantRef: variantRef(v4),
      },
    ]);

    // 8. A later figure from the ERP replaces the earlier one; the earlier one is never added to it.
    const laterMain = yield* importFigure({
      amount: '10',
      configuration: shop,
      itemKey: 'SKU-1',
      locationKey: 'WH-MAIN',
      position: mainV1,
      revision: '2',
    });
    const refreshed = yield* readPage(shop.customerConfigurationId, [v1]);
    expect(refreshed.items).toMatchObject([
      {
        outcome: 'ON_HAND',
        positions: [{ onHand: reported('10', laterMain) }, { onHand: reported('3.5', second) }],
        total: { amount: '13.5', unitRef },
      },
    ]);

    // 9. The other shop's figure never appears in this shop, and this shop's never in the other one.
    const other = yield* readPage(otherShop.customerConfigurationId, [v1]);
    expect(other.items).toMatchObject([
      {
        outcome: 'ON_HAND',
        positions: [{ positionRef: otherMainV1.ref }],
        total: { amount: '99', unitRef },
      },
    ]);
    expect(other.items[0]).toMatchObject({
      positions: expect.not.arrayContaining([expect.objectContaining({ positionRef: mainV1.ref })]),
    });
    const unconfigured = yield* readPage(`on-hand-page-unconfigured-${yield* nextId}`, [v1]).pipe(Effect.flip);
    expect(Schema.is(CatalogVariantOnHandPageNotFoundProblemSchema)(unconfigured)).toBe(true);

    // 10. Who may read it, as Core's production gate decides over this database: the reader holds the read, the
    // denied staff member only another Inventory read; the storefront client is bound to the storefront workload
    // for the operator's company, the second client holds no binding.
    yield* grantTestTenantRoleAccess({
      holders: [
        { capabilityKeys: [READ_KEY ?? ''], principalId: fixture.reader.principalId },
        {
          capabilityKeys: ['commerce.inventory.stock-position.list-relevant'],
          principalId: fixture.denied.principalId,
        },
      ],
      legalEntityIds: [fixture.legalEntityId, secondCompanyId],
      spiceDb: yield* liveFixtureSpiceDb(fixture.permissionEnvironment),
      tenantId,
      writerConnectionString: Redacted.make(connections.runtime.connectionString),
    });
    const admin = yield* makeCoreDatabase(connections.admin);
    const seedStorefront = Effect.fn('CatalogVariantOnHandPageTest.seedStorefront')(function* seedStorefront(
      label: string,
      registeredCompanies?: readonly string[],
    ) {
      const principalId = yield* nextId;
      yield* admin.executor.insert(principals).values({
        displayName: `On-hand page storefront ${label}`,
        kind: 'service',
        principalId,
        status: 'active',
        tenantId,
      });
      if (registeredCompanies !== undefined) {
        yield* admin.executor.execute(
          sql`insert into core.access_workload_bindings
                (binding_id, tenant_id, principal_id, workload_key, status, incarnation, created_at)
              values (gen_random_uuid(), ${tenantId}::uuid, ${principalId}::uuid, ${STOREFRONT_WORKLOAD},
                      'active', gen_random_uuid(), now())`,
          'objects',
        );
        for (const legalEntityId of registeredCompanies) {
          yield* admin.executor.execute(
            sql`insert into core.access_workload_company_bindings
                  (company_binding_id, tenant_id, workload_binding_id, legal_entity_id, status, incarnation, created_at)
                select gen_random_uuid(), tenant_id, binding_id, ${legalEntityId}::uuid, 'active', gen_random_uuid(), now()
                  from core.access_workload_bindings
                 where tenant_id = ${tenantId}::uuid and principal_id = ${principalId}::uuid
                   and workload_key = ${STOREFRONT_WORKLOAD} and status = 'active'`,
            'objects',
          );
        }
      }
      return principalId;
    });
    const boundStorefront = yield* seedStorefront('bound', [fixture.legalEntityId]);
    const unboundStorefront = yield* seedStorefront('unbound');
    const gateLayer = AccessDecisionLive.pipe(
      Layer.provideMerge(AccessEnforcementPortsLive),
      Layer.provide(TenantIntentLoaderLive),
      Layer.provide(CorePersistenceLive),
      Layer.provide(
        Layer.succeed(
          DatabaseConfig,
          yield* parseDatabaseConfig({ DATABASE_URL: connections.runtime.connectionString }),
        ),
      ),
      Layer.provide(Layer.succeed(DatabaseIdentityEnrollmentContext, defineDatabaseIdentityEnrollment([]))),
      Layer.provide(NodeCrypto.layer),
    );
    // Built in the test's own scope, so the gate's database pool stays open for every decision below.
    const gate = Context.get(yield* Layer.build(gateLayer), AccessDecisionGate);
    const carrier = {
      accessDeclaration: catalogVariantOnHandPageRead.descriptor.accessDeclaration,
      accessWorkload: catalogVariantOnHandPageRead.descriptor.accessWorkload,
    };
    const decide = Effect.fn('CatalogVariantOnHandPageTest.decide')(function* decide(
      principal: Omit<typeof TrustedPrincipalContextSchema.Encoded, 'legalEntityId'>,
      legalEntityId: string,
    ) {
      const scope = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({ ...principal, legalEntityId });
      const decision = yield* gate.decide({
        carrier,
        legalEntityScope: 'required',
        now: DateTime.toDateUtc(yield* DateTime.now),
        scope: { ...scope, correlationId: `on-hand-page-${yield* nextId}` },
      });
      return { codes: decision.reasons.map(({ code }) => code), outcome: decision.outcome };
    });
    const storefront = (principalId: string) => ({
      authBindingId: principalId,
      authContextRef: `better-auth-api-key:${principalId}`,
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      authMethod: 'api_key' as const,
      principalId,
      tenantId,
    });
    expect(yield* decide(storefront(boundStorefront), fixture.legalEntityId)).toEqual({
      codes: ['allow.workload'],
      outcome: 'ALLOWED',
    });
    expect(yield* decide(storefront(boundStorefront), secondCompanyId)).toEqual({
      codes: ['deny.workload_unbound'],
      outcome: 'DENIED',
    });
    expect(yield* decide(storefront(unboundStorefront), fixture.legalEntityId)).toEqual({
      codes: ['deny.workload_unbound'],
      outcome: 'DENIED',
    });
    expect(yield* decide(fixture.reader, fixture.legalEntityId)).toMatchObject({ outcome: 'ALLOWED' });
    const deniedStaff = yield* decide(fixture.denied, fixture.legalEntityId);
    expect(deniedStaff.outcome).toBe('DENIED');
    expect(deniedStaff.codes).not.toContain('allow.workload');
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer), Effect.provide(NodeServices.layer)),
);
