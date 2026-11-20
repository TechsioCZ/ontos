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
import { and, eq, sql } from 'drizzle-orm';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Redacted,
  Result,
  Schema,
} from 'effect';
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
import { EstablishStockPositionActionIneligibleProblemSchema } from '../../shared/apis/establish-stock-position-action.ts';
import { ImportSourceAssertionActionCommitIndeterminateProblemSchema } from '../../shared/apis/import-source-assertion-action.ts';
import { InventorySourceImportReceiptResponseSchema } from '../../shared/apis/inventory-source-import-receipt.ts';
import {
  RegisterStockItemActionConflictProblemSchema,
  RegisterStockItemActionIneligibleProblemSchema,
} from '../../shared/apis/register-stock-item-action.ts';
import { InventorySourceAssertionProposalSchema } from '../../shared/domain/inventory-source-assertion.ts';
import { InventorySourceImportActionInvocationIdSchema } from '../../shared/domain/inventory-source-import-outcome.ts';
import { transitionStockLocation } from '../../shared/domain/stock-location.ts';
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
import {
  inventoryBackendConfigurations,
  inventoryStockItems,
  inventoryStockPositions,
} from '../../src/database/schema.ts';
import { importSourceAssertionOwnerAuthorizationOverlayLive } from '../../src/persistence/import-source-assertion-owner-authorization.ts';
import { makeDrizzleStockItemRepository } from '../../src/persistence/stock-item-repository.ts';
import { stockLocationPersistenceForScope } from '../../src/persistence/stock-location-repository.ts';
import { inventoryRegistration } from '../../vertical.registration.ts';
import { requireExecutionResult } from '../support/action-execution-result.ts';
import { sourceImportCompositionFixture } from '../support/source-import-composition.fixture.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());

/**
 * Catalog-owned inputs. This Inventory test does not run Catalog: these stand for the exact Selection meanings
 * and the Product Unit a Catalog Product Variant supplies, and Inventory retains them without interpreting them.
 */
const CATALOG_PRODUCT_UNIT_ID = 'c47a1001-0000-4000-8000-000000000001';
const CATALOG_SELECTION_MEANING_ID = 'catalog-variant:fixture-sku-1';
const CATALOG_RACE_SELECTION_MEANING_ID = 'catalog-variant:fixture-sku-race';
const CATALOG_RETIRED_SELECTION_MEANING_ID = 'catalog-variant:fixture-sku-retired';

/**
 * The state an External Business System stock import needs is established only through the governed
 * Inventory Actions an operator invokes; no owner row is inserted by the test. The final import is the exact
 * owner operation the Symmy stock route enrolls: one ABSOLUTE_PHYSICAL_ON_HAND assertion ordered by the
 * source revision, issued by the selected external backend. Every step, the import and its receipt read included,
 * runs under an operator's staff token, not under a registered workload.
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
    const options = Effect.fn('ExternalBackendSetupTest.options')(function* options(idempotencyKey?: string) {
      return {
        baseUrl: 'https://inventory.ontos.test',
        compositionRevision: composition.composition.revision,
        idempotencyKey: idempotencyKey ?? (yield* nextId),
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
      resourceId: CATALOG_PRODUCT_UNIT_ID,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    } as const;
    const register = Effect.fn('ExternalBackendSetupTest.register')(function* register(
      exactSelectionMeaningId: string,
      idempotencyKey?: string,
    ) {
      return yield* run(
        requireExecutionResult(
          RegisterStockItemResultSchema,
          executeRegisterStockItemWithAuthorization(
            yield* Schema.decodeUnknownEffect(RegisterStockItemPayloadSchema)({
              exactSelectionMeaning: { id: exactSelectionMeaningId, kind: 'PRODUCT_VARIANT' },
              unitRef,
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(idempotencyKey),
          ),
        ),
      );
    });
    const registrationKey = yield* nextId;
    const registered = yield* register(CATALOG_SELECTION_MEANING_ID, registrationKey);
    const { stockItem } = registered;
    // A lost reply is recovered under the same key; the same key never carries another payload.
    expect(yield* register(CATALOG_SELECTION_MEANING_ID, registrationKey)).toEqual(registered);
    const reusedKey = yield* register(CATALOG_RACE_SELECTION_MEANING_ID, registrationKey).pipe(Effect.flip);
    assert(Schema.is(RegisterStockItemActionConflictProblemSchema)(reusedKey));
    expect(reusedKey.code).toBe('action_request_hash_conflict');
    // An operator who lost the key is refused with the Item that already exists.
    const lostKey = yield* register(CATALOG_SELECTION_MEANING_ID).pipe(Effect.flip);
    assert(Schema.is(RegisterStockItemActionIneligibleProblemSchema)(lostKey));
    expect(lostKey).toMatchObject({
      reason: 'exact_selection_meaning_already_registered',
      stockItemId: stockItem.stockItemRef.resourceId,
    });
    // Two keys racing for one meaning register one Item, and the loser is refused naming it.
    const registrationRace = yield* Effect.all(
      [
        register(CATALOG_RACE_SELECTION_MEANING_ID).pipe(Effect.result),
        register(CATALOG_RACE_SELECTION_MEANING_ID).pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    const registrationWinners = registrationRace.filter(Result.isSuccess);
    expect(registrationWinners).toHaveLength(1);
    for (const outcome of registrationRace) {
      if (Result.isFailure(outcome)) {
        assert(Schema.is(RegisterStockItemActionIneligibleProblemSchema)(outcome.failure));
        expect(outcome.failure).toMatchObject({
          reason: 'exact_selection_meaning_already_registered',
          stockItemId: registrationWinners[0]?.success.stockItem.stockItemRef.resourceId,
        });
      }
    }

    // 3. One ACTIVE Stock Location for the ERP's physical warehouse.
    const createLocation = Effect.fn('ExternalBackendSetupTest.createLocation')(function* createLocation(
      displayName: string,
    ) {
      return yield* run(
        requireExecutionResult(
          CreateStockLocationResultSchema,
          executeCreateStockLocationWithAuthorization(
            yield* Schema.decodeUnknownEffect(CreateStockLocationPayloadSchema)({
              displayName,
              operationalScope: { _tag: 'PHYSICAL_SITE', physicalSiteKeys: ['erp-site:main'] },
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(),
          ),
        ),
      );
    });
    const { stockLocation } = yield* createLocation('ERP main warehouse');

    // 4. The Position starts UNKNOWN under the selected backend; this Action never writes a quantity.
    const establish = Effect.fn('ExternalBackendSetupTest.establish')(function* establish(
      scope: { readonly stockItemRef: unknown; readonly stockLocationRef: unknown },
      idempotencyKey?: string,
    ) {
      return yield* run(
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
              scope: { ...scope, customerConfigurationId, unitRef },
            }),
            yield* authorization(),
            yield* nextId,
            yield* options(idempotencyKey),
          ),
        ),
      );
    });
    const positionScope = { stockItemRef: stockItem.stockItemRef, stockLocationRef: stockLocation.ref };
    // Two keys racing for one scope establish one Position, and the loser is refused naming it.
    const establishmentKeys = [yield* nextId, yield* nextId] as const;
    const establishmentRace = yield* Effect.all(
      establishmentKeys.map((key) => establish(positionScope, key).pipe(Effect.result)),
      { concurrency: 2 },
    );
    const winnerIndex = establishmentRace.findIndex(Result.isSuccess);
    const winner = establishmentRace[winnerIndex];
    const loser = establishmentRace[1 - winnerIndex];
    assert(winner !== undefined && Result.isSuccess(winner) && loser !== undefined && Result.isFailure(loser));
    const { stockPosition } = winner.success;
    expect(Schema.is(UnknownOnHandEvidenceSchema)(stockPosition.onHand)).toBe(true);
    assert(Schema.is(EstablishStockPositionActionIneligibleProblemSchema)(loser.failure));
    expect(loser.failure).toMatchObject({ positionRef: stockPosition.ref, reason: 'POSITION_SCOPE_ALREADY_CURRENT' });
    expect(yield* establish(positionScope, establishmentKeys[winnerIndex])).toEqual(winner.success);

    // A retired Stock Item or a merged Stock Location cannot receive a new Position.
    const { stockItem: retiringItem } = yield* register(CATALOG_RETIRED_SELECTION_MEANING_ID);
    const { stockLocation: mergingLocation } = yield* createLocation('ERP overflow warehouse');
    const transitionedAt = DateTime.formatIso(yield* DateTime.now);
    yield* fixture
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* endTargetLifecycles() {
          yield* makeDrizzleStockItemRepository(transaction).retire(retiringItem, transitionedAt);
          const merged = yield* transitionStockLocation(mergingLocation, {
            _tag: 'MERGE',
            reason: 'Merged into the ERP main warehouse',
            successorRef: stockLocation.ref,
            transitionedAt,
          });
          yield* stockLocationPersistenceForScope(transaction, scope).saveTransition({
            expectedRevision: mergingLocation.revision,
            next: merged,
          });
        }),
      )
      .pipe(Effect.provide(ownerRuntimeLayer));
    for (const [scope, reason] of [
      [{ stockItemRef: retiringItem.stockItemRef, stockLocationRef: stockLocation.ref }, 'STOCK_ITEM_NOT_CURRENT'],
      [{ stockItemRef: stockItem.stockItemRef, stockLocationRef: mergingLocation.ref }, 'STOCK_LOCATION_NOT_ACTIVE'],
    ] as const) {
      const refused = yield* establish(scope).pipe(Effect.flip);
      assert(Schema.is(EstablishStockPositionActionIneligibleProblemSchema)(refused));
      expect(refused.reason).toBe(reason);
    }

    // Establishment locks the backend configuration before the Item, the order in which establishing a
    // Reservation locks them (the Obligation's authority trigger, then its Requirement's scope trigger). This
    // transaction takes those two locks in that order while the Item gets a Position at a second Location:
    // establishment waits at the configuration without holding the Item, so the Item lock is granted at once.
    const { stockLocation: secondLocation } = yield* createLocation('ERP second warehouse');
    const ownerConfigurationRow = and(
      eq(inventoryBackendConfigurations.tenantId, tenantId),
      eq(inventoryBackendConfigurations.configurationId, configuration.configurationId),
    );
    const configurationLocked = yield* Deferred.make<number>();
    const lockItem = yield* Deferred.make<null>();
    const reservationOrder = yield* fixture
      .prepareOwner((transaction) =>
        Effect.gen(function* lockLikeReservationEstablishment() {
          yield* transaction
            .select({ id: inventoryBackendConfigurations.configurationId })
            .from(inventoryBackendConfigurations)
            .where(ownerConfigurationRow)
            .for('update');
          // Test infrastructure metadata only: identify this blocker connection without exposing query text.
          const [backend] = yield* transaction
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(inventoryBackendConfigurations)
            .where(ownerConfigurationRow);
          assert(backend !== undefined);
          yield* Deferred.succeed(configurationLocked, backend.pid);
          yield* Deferred.await(lockItem);
          // A wait here is the deadlock this ordering prevents; fail fast instead of waiting for detection.
          yield* transaction
            .select({ timeout: sql<string>`set_config('lock_timeout', '500ms', true)` })
            .from(inventoryBackendConfigurations)
            .where(ownerConfigurationRow);
          return yield* transaction
            .select({ id: inventoryStockItems.stockItemId })
            .from(inventoryStockItems)
            .where(
              and(
                eq(inventoryStockItems.tenantId, tenantId),
                eq(inventoryStockItems.stockItemId, stockItem.stockItemRef.resourceId),
              ),
            )
            .for('update');
        }),
      )
      .pipe(Effect.provide(ownerRuntimeLayer), Effect.forkChild);
    const blockerPid = yield* Deferred.await(configurationLocked);
    const secondEstablishment = yield* establish({
      stockItemRef: stockItem.stockItemRef,
      stockLocationRef: secondLocation.ref,
    }).pipe(Effect.forkChild);
    let establishmentWaits = false;
    for (let attempt = 0; attempt < 80 && !establishmentWaits; attempt += 1) {
      // Only this disposable database's wait graph is inspected, never SQL text or foreign business rows.
      const [row] = yield* fixture
        .prepareOwner((transaction) =>
          transaction
            .select({
              waiting: sql<boolean>`exists(select 1 from pg_stat_activity as activity
                where activity.datname = current_database()
                  and ${blockerPid} = any(pg_blocking_pids(activity.pid)))`,
            })
            .from(inventoryBackendConfigurations)
            .where(ownerConfigurationRow),
        )
        .pipe(Effect.provide(ownerRuntimeLayer));
      establishmentWaits = row?.waiting ?? false;
      if (!establishmentWaits) {
        yield* Effect.sleep('25 millis');
      }
    }
    expect(establishmentWaits).toBe(true);
    yield* Deferred.succeed(lockItem, null);
    expect(yield* Fiber.join(reservationOrder)).toEqual([{ id: stockItem.stockItemRef.resourceId }]);
    const { stockPosition: secondPosition } = yield* Fiber.join(secondEstablishment);
    expect(secondPosition.scope.stockLocationRef).toEqual(secondLocation.ref);

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
    // The import commits but its acknowledgement is lost: the operator holds only the invocation id the public
    // commit-indeterminate problem names.
    fixture.faultNextTransaction('lost-ack');
    const lostImport = yield* run(
      requireExecutionResult(
        ImportSourceAssertionResultSchema,
        executeImportSourceAssertionWithAuthorization(
          { authorizationTargetRef: stockPosition.ref, items: [proposal] },
          yield* authorization(),
          yield* nextId,
          yield* options(),
        ),
      ),
    ).pipe(Effect.flip);
    assert(Schema.is(ImportSourceAssertionActionCommitIndeterminateProblemSchema)(lostImport));
    expect(lostImport).toMatchObject({ resolution: 'RESOLVE_COMMIT', retryCommand: false, status: 503 });

    // 7. The operator recovers the accepted row, with its ERP provenance, through Inventory's public receipt read
    // by that invocation id, without an administrative lookup. This proves operator recovery only: the staff
    // token carries no registered recovery, so the read's signed-recovery check
    // (src/api/inventory-source-import-receipt.read.ts) is skipped. Registered-workload recovery of this receipt
    // is not covered by any database-backed test: tests/unit/inventory-source-import-receipt.test.ts checks only
    // the signed-claim match, and apps/shell-super-app/tests/integration/registered-workload-gateway-native.test.ts
    // covers registered recovery for other owners' operations, not for this read.
    const receipt = yield* run(
      executeInventorySourceImportReceiptWithAuthorization(
        {
          actionInvocationId: InventorySourceImportActionInvocationIdSchema.make(lostImport.invocationId),
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
    expect(new Set(positions.map(({ id }) => id))).toEqual(
      new Set([stockPosition.ref.resourceId, secondPosition.ref.resourceId]),
    );
  }).pipe(Effect.provide(NodeCrypto.layer), Effect.provide(NodeServices.layer)),
);
