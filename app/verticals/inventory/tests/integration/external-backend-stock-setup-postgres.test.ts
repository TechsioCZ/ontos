import { generateKeyPairSync, sign } from 'node:crypto';

import {
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
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { createStockLocationActionApiLive } from '../../api/create-stock-location-action-server.ts';
import { establishExternalStockCorrelationActionApiLive } from '../../api/establish-external-stock-correlation-action-server.ts';
import { establishStockPositionActionApiLive } from '../../api/establish-stock-position-action-server.ts';
import { importSourceAssertionActionApiLive } from '../../api/import-source-assertion-action-server.ts';
import { inventorySourceImportReceiptReadApiLive } from '../../api/inventory-source-import-receipt-read-server.ts';
import { registerStockItemActionApiLive } from '../../api/register-stock-item-action-server.ts';
import { selectInventoryBackendActionApiLive } from '../../api/select-inventory-backend-action-server.ts';
import {
  CreateStockLocationPayloadSchema,
  CreateStockLocationResultSchema,
} from '../../shared/actions/create-stock-location.ts';
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
import { InventorySourceImportReceiptResponseSchema } from '../../shared/apis/inventory-source-import-receipt.ts';
import { InventorySourceAssertionProposalSchema } from '../../shared/domain/inventory-source-assertion.ts';
import { InventorySourceImportActionInvocationIdSchema } from '../../shared/domain/inventory-source-import-outcome.ts';
import { UnknownOnHandEvidenceSchema } from '../../shared/domain/stock-position.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createStockLocationAction } from '../../src/actions/create-stock-location.action.ts';
import { establishExternalStockCorrelationAction } from '../../src/actions/establish-external-stock-correlation.action.ts';
import { establishStockPositionAction } from '../../src/actions/establish-stock-position.action.ts';
import { importSourceAssertionAction } from '../../src/actions/import-source-assertion.action.ts';
import { registerStockItemAction } from '../../src/actions/register-stock-item.action.ts';
import { selectInventoryBackendAction } from '../../src/actions/select-inventory-backend.action.ts';
import { executeCreateStockLocationWithAuthorization } from '../../src/api/create-stock-location-action-client.ts';
import { executeEstablishExternalStockCorrelationWithAuthorization } from '../../src/api/establish-external-stock-correlation-action-client.ts';
import { executeEstablishStockPositionWithAuthorization } from '../../src/api/establish-stock-position-action-client.ts';
import { executeImportSourceAssertionWithAuthorization } from '../../src/api/import-source-assertion-action-client.ts';
import { executeInventorySourceImportReceiptWithAuthorization } from '../../src/api/inventory-source-import-receipt-client.ts';
import { executeRegisterStockItemWithAuthorization } from '../../src/api/register-stock-item-action-client.ts';
import { executeSelectInventoryBackendWithAuthorization } from '../../src/api/select-inventory-backend-action-client.ts';
import { inventorySourceImportLedger, inventoryStockPositions } from '../../src/database/schema.ts';
import { importSourceAssertionOwnerAuthorizationOverlayLive } from '../../src/persistence/import-source-assertion-owner-authorization.ts';
import { inventoryRegistration } from '../../vertical.registration.ts';
import { requireExecutionResult } from '../support/action-execution-result.ts';
import { sourceImportCompositionFixture } from '../support/source-import-composition.fixture.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());

/**
 * The state an External Business System stock import needs is established only through the governed
 * Inventory Actions an operator invokes; no owner row is inserted by the test. The final import is the exact
 * owner operation the Symmy stock route enrolls: one ABSOLUTE_PHYSICAL_ON_HAND assertion ordered by the
 * source revision, issued by the selected external backend.
 */
it.live('operator Actions set up one external-backend Stock Position whose source stock import is accepted', () =>
  Effect.gen(function* externalBackendStockSetup() {
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
          createStockLocationAction.descriptor.actionKey,
          establishStockPositionAction.descriptor.actionKey,
          establishExternalStockCorrelationAction.descriptor.actionKey,
          importSourceAssertionAction.descriptor.actionKey,
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
    const kid = 'inventory-external-backend-setup';
    const tokenIssuer = 'https://disposable-shell.ontos.test';
    const jwks = JSON.stringify({
      keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
    });
    const authorization = Effect.fn('ExternalBackendSetupTest.authorization')(function* authorization() {
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          aud: 'inventory',
          compositionRevision: composition.composition.revision,
          exp: now + 300,
          iat: now,
          iss: tokenIssuer,
          jti: yield* nextId,
          principal: fixture.manager,
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
      .add(inventoryApi.groups.createStockLocationAction)
      .add(inventoryApi.groups.establishStockPositionAction)
      .add(inventoryApi.groups.establishExternalStockCorrelationAction)
      .add(inventoryApi.groups.importSourceAssertionAction)
      .add(inventoryApi.groups.inventorySourceImportReceipt);
    const handlers = Layer.mergeAll(
      selectInventoryBackendActionApiLive,
      registerStockItemActionApiLive,
      createStockLocationActionApiLive,
      establishStockPositionActionApiLive,
      establishExternalStockCorrelationActionApiLive,
      importSourceAssertionActionApiLive,
      inventorySourceImportReceiptReadApiLive,
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
    const options = Effect.fn('ExternalBackendSetupTest.options')(function* options() {
      return {
        baseUrl: 'https://inventory.ontos.test',
        compositionRevision: composition.composition.revision,
        idempotencyKey: yield* nextId,
      };
    });
    const run = <Result, Failure, Requirements>(effect: Effect.Effect<Result, Failure, Requirements>) =>
      effect.pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));

    // 1. The Customer Configuration selects the customer's ERP as its one Inventory Backend.
    const customerConfigurationId = `external-backend-setup-${yield* nextId}`;
    const issuer = { backendId: 'erp-external-backend-setup', backendKind: 'external_business_system' } as const;
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

    // 2. One Stock Item for the exact Catalog Selection meaning and Unit of the imported SKU.
    const unitRef = {
      moduleId: 'commerce.catalog',
      resourceId: yield* nextId,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    } as const;
    const { stockItem } = yield* run(
      requireExecutionResult(
        RegisterStockItemResultSchema,
        executeRegisterStockItemWithAuthorization(
          yield* Schema.decodeUnknownEffect(RegisterStockItemPayloadSchema)({
            exactSelectionMeaning: { id: `catalog-variant:${yield* nextId}`, kind: 'PRODUCT_VARIANT' },
            unitRef,
          }),
          yield* authorization(),
          yield* nextId,
          yield* options(),
        ),
      ),
    );

    // 3. One ACTIVE Stock Location for the ERP's physical warehouse.
    const { stockLocation } = yield* run(
      requireExecutionResult(
        CreateStockLocationResultSchema,
        executeCreateStockLocationWithAuthorization(
          yield* Schema.decodeUnknownEffect(CreateStockLocationPayloadSchema)({
            displayName: 'ERP main warehouse',
            operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['erp-site:main'] },
          }),
          yield* authorization(),
          yield* nextId,
          yield* options(),
        ),
      ),
    );

    // 4. The Position starts UNKNOWN under the selected backend; this Action never writes a quantity.
    const { stockPosition } = yield* run(
      requireExecutionResult(
        EstablishStockPositionResultSchema,
        executeEstablishStockPositionWithAuthorization(
          yield* Schema.decodeUnknownEffect(EstablishStockPositionPayloadSchema)({
            ownerConfigurationRef: {
              moduleId: 'commerce.inventory',
              resourceId: configuration.configurationId,
              resourceType: 'commerce.inventory.inventory-backend-configuration',
              tenantId,
            },
            scope: {
              customerConfigurationId,
              stockItemRef: stockItem.stockItemRef,
              stockLocationRef: stockLocation.ref,
              unitRef,
            },
          }),
          yield* authorization(),
          yield* nextId,
          yield* options(),
        ),
      ),
    );
    expect(Schema.is(UnknownOnHandEvidenceSchema)(stockPosition.onHand)).toBe(true);

    // 5. The ERP's own item and location keys correlate to the exact Item and Location.
    const externalKey = (identifierKind: 'ITEM' | 'LOCATION', externalValue: string) => ({
      customerConfigurationId,
      externalScope: 'erp-company:main',
      externalValue,
      identifierKind,
      issuer,
      namespace: 'erp-stock',
      tenantId,
    });
    const correlate = Effect.fn('ExternalBackendSetupTest.correlate')(function* correlate(
      key: ReturnType<typeof externalKey>,
      target: { readonly _tag: 'STOCK_ITEM' | 'STOCK_LOCATION'; readonly ref: unknown },
    ) {
      return yield* run(
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
              effectiveFrom: configuration.selectedAt,
              externalKey: key,
              ownerEvidenceRef: `erp-stock:${key.identifierKind}:${key.externalValue}`,
              target,
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
    });
    yield* correlate(externalKey('ITEM', 'SKU-1'), { _tag: 'STOCK_ITEM', ref: stockItem.stockItemRef });
    yield* correlate(externalKey('LOCATION', 'WH-MAIN'), { _tag: 'STOCK_LOCATION', ref: stockLocation.ref });

    // 6. The owner operation the Symmy stock route enrolls, with what the ERP must send per row.
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const proposal = yield* Schema.decodeUnknownEffect(InventorySourceAssertionProposalSchema)({
      assertionId: yield* nextId,
      businessObservedAt: observedAt,
      coverage: [],
      customerConfigurationId,
      factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
      issuer,
      itemExternalKey: externalKey('ITEM', 'SKU-1'),
      locationExternalKey: externalKey('LOCATION', 'WH-MAIN'),
      orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '1' },
      ownerEvidenceRef: 'erp-stock:snapshot:1',
      positionRef: stockPosition.ref,
      quantity: { amount: '12', unitRef },
      receivedAt: observedAt,
      sourceReference: 'erp-stock:snapshot:1',
    });
    const imported = yield* run(
      requireExecutionResult(
        ImportSourceAssertionResultSchema,
        executeImportSourceAssertionWithAuthorization(
          { authorizationTargetRef: stockPosition.ref, items: [proposal] },
          yield* authorization(),
          yield* nextId,
          yield* options(),
        ),
      ),
    );
    expect(imported.items).toMatchObject([{ assertionId: proposal.assertionId, status: 'ACCEPTED' }]);

    // 7. The accepted row is readable through Inventory's public receipt read, with its ERP provenance.
    const [ledger] = yield* fixture
      .prepareOwner((transaction) =>
        transaction
          .select({ actionInvocationId: inventorySourceImportLedger.actionInvocationId })
          .from(inventorySourceImportLedger)
          .where(eq(inventorySourceImportLedger.tenantId, tenantId)),
      )
      .pipe(Effect.provide(ownerRuntimeLayer));
    assert(ledger !== undefined);
    const receipt = yield* run(
      executeInventorySourceImportReceiptWithAuthorization(
        {
          actionInvocationId: InventorySourceImportActionInvocationIdSchema.make(ledger.actionInvocationId),
          itemIndex: 0,
          proposal,
        },
        yield* authorization(),
        yield* nextId,
        { baseUrl: 'https://inventory.ontos.test', compositionRevision: composition.composition.revision },
      ),
    );
    assert(Schema.is(InventorySourceImportReceiptResponseSchema.members[0])(receipt));
    expect(receipt.receipt.outcome).toMatchObject({ status: 'ACCEPTED' });
    expect(receipt.receipt.proposal).toMatchObject({
      issuer,
      orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '1' },
      quantity: { amount: '12', unitRef },
      sourceReference: 'erp-stock:snapshot:1',
    });
    const positions = yield* fixture
      .prepareOwner((transaction) =>
        transaction
          .select({ id: inventoryStockPositions.stockPositionId })
          .from(inventoryStockPositions)
          .where(eq(inventoryStockPositions.tenantId, tenantId)),
      )
      .pipe(Effect.provide(ownerRuntimeLayer));
    expect(positions).toEqual([{ id: stockPosition.ref.resourceId }]);
  }).pipe(Effect.provide(NodeCrypto.layer), Effect.provide(NodeServices.layer)),
);
