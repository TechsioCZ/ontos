import { inventoryRegistration } from '../../vertical.registration.ts';
import { Reactivity } from 'effect/reactivity';
import { PgClient } from '@effect/sql-pg';
import { generateKeyPairSync, sign } from 'node:crypto';

import { GatewayAssertionRedemptionService, GatewayAssertionReplayError, findPostgresFailure } from '@app/core-runtime';
import type { OwnerAuthorizationInput } from '@app/core-runtime';
import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { sourceImportCompositionFixture } from '../support/source-import-composition.fixture.ts';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { eq } from 'drizzle-orm';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { inventorySourceImportReceiptReadApiLive } from '../../api/inventory-source-import-receipt-read-server.ts';
import { InventorySourceImportReceiptResponseSchema } from '../../shared/apis/inventory-source-import-receipt.ts';
import { executeInventorySourceImportReceiptWithAuthorization } from '../../src/api/inventory-source-import-receipt-client.ts';
import { importSourceAssertionActionApiLive } from '../../api/import-source-assertion-action-server.ts';
import { inventoryApi } from '../../shared/api.ts';
import {
  ImportSourceAssertionActionAlreadyCommittedProblemSchema,
  ImportSourceAssertionActionInvalidProblemSchema,
  ImportSourceAssertionActionPreconditionProblemSchema,
  ImportSourceAssertionActionUnavailableProblemSchema,
} from '../../shared/apis/import-source-assertion-action.ts';
import {
  InventorySourceImportActionInvocationIdSchema,
  InventorySourceImportLedgerEntrySchema,
} from '../../shared/domain/inventory-source-import-outcome.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { InventorySourceAssertionProposalSchema } from '../../shared/domain/inventory-source-assertion.ts';
import { ExternalStockCorrelationSchema } from '../../shared/domain/external-stock-correlation.ts';
import {
  PhysicalStockEffectRequestSchema,
  AppliedPhysicalStockEffectSchema,
} from '../../shared/domain/physical-stock-effect.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockLocationSchema } from '../../shared/domain/stock-location.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { importSourceAssertionAction } from '../../src/actions/import-source-assertion.action.ts';
import {
  prepareImportSourceAssertionRequestIdentity,
  ImportSourceAssertionResultSchema,
} from '../../shared/actions/import-source-assertion.ts';
import { requireExecutionResult } from '../support/action-execution-result.ts';
import { executeImportSourceAssertionWithAuthorization } from '../../src/api/import-source-assertion-action-client.ts';
import {
  inventorySourceAssertions,
  inventorySourceImportLedger,
  inventoryPhysicalStockEffects,
} from '../../src/database/schema.ts';
import { externalStockCorrelationPersistenceForScope } from '../../src/persistence/external-stock-correlation-repository.ts';
import { inventoryBackendConfigurationPersistenceForScope } from '../../src/persistence/inventory-backend-configuration-repository.ts';
import { inventorySourceAssertionPersistenceForScope } from '../../src/persistence/inventory-source-assertion-repository.ts';
import { inventorySourceImportLedgerPersistenceForScope } from '../../src/persistence/inventory-source-import-ledger-repository.ts';
import { physicalStockEffectPersistenceForScope } from '../../src/persistence/physical-stock-effect-repository.ts';
import {
  StockItemRepository,
  stockItemRepositoryLayerForTransaction,
  makeDrizzleStockItemRepository,
} from '../../src/persistence/stock-item-repository.ts';
import { stockLocationPersistenceForScope } from '../../src/persistence/stock-location-repository.ts';
import { stockPositionPersistenceForScope } from '../../src/persistence/stock-position-repository.ts';
import {
  importSourceAssertionOwnerAuthorizationOverlay,
  importSourceAssertionOwnerAuthorizationOverlayLive,
} from '../../src/persistence/import-source-assertion-owner-authorization.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());
const observedAt = '2026-09-24T10:00:00.000Z';
const selectedAt = '2026-09-24T09:00:00.000Z';

it.live(
  'generated Import preserves committed uncertain Source Assertion through fresh invocation, batch, race and rollback',
  () =>
    Effect.gen(function* nativeIndeterminateRetry() {
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
          actionKeys: [importSourceAssertionAction.descriptor.actionKey],
          adminConnectionString: Redacted.make(connections.admin.connectionString),
          allowedAudiences: ['inventory'],
          applicationComposition: { load: Effect.succeed(composition) },
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.composition.revision,
          expectedDeployment: ultramodernApiMarker,
          moduleKeys: ['commerce.inventory'],
          ownerRegistration: inventoryRegistration,
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      const coreEvidenceServices = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(connections.admin.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      );
      const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceServices));
      const ownerRuntimeLayer = fixture.layer.pipe(Layer.provide(importSourceAssertionOwnerAuthorizationOverlayLive));
      const { tenantId } = fixture;
      const [
        configurationId,
        itemId,
        locationId,
        positionId,
        unitId,
        itemCorrelationId,
        locationCorrelationId,
        effectId,
      ] = yield* Effect.all(
        Array.from({ length: 8 }, () => nextId),
        { concurrency: 1 },
      );
      assert(
        configurationId !== undefined &&
          itemId !== undefined &&
          locationId !== undefined &&
          positionId !== undefined &&
          unitId !== undefined &&
          itemCorrelationId !== undefined &&
          locationCorrelationId !== undefined &&
          effectId !== undefined,
      );
      const customerConfigurationId = `source-retry-${configurationId}`;
      const unitRef = {
        moduleId: 'commerce.catalog',
        resourceId: unitId,
        resourceType: 'commerce.catalog.product-unit',
        tenantId,
      };
      const positionRef = {
        moduleId: 'commerce.inventory',
        resourceId: positionId,
        resourceType: 'commerce.inventory.stock-position',
        tenantId,
      };
      const itemRef = {
        moduleId: 'commerce.inventory',
        resourceId: itemId,
        resourceType: 'commerce.inventory.stock-item',
        tenantId,
      };
      const locationRef = {
        moduleId: 'commerce.inventory',
        resourceId: locationId,
        resourceType: 'commerce.inventory.stock-location',
        tenantId,
      };
      const configurationRef = {
        moduleId: 'commerce.inventory',
        resourceId: configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      };
      const issuer = { backendId: 'erp-source-retry', backendKind: 'external_business_system' };
      const configuration = yield* Schema.decodeUnknownEffect(InventoryBackendConfigurationSchema)({
        configurationId,
        customerConfigurationId,
        revision: 1,
        selectedAt,
        selection: {
          backend: 'external_business_system',
          backendId: issuer.backendId,
          exactReservationCapability: 'SUPPORTED',
          stockCorrectionCapability: 'UNSUPPORTED',
        },
        tenantId,
      });
      const externalKey = (identifierKind: 'ITEM' | 'LOCATION') => ({
        customerConfigurationId,
        externalScope: 'warehouse:retry',
        externalValue: identifierKind,
        identifierKind,
        issuer,
        namespace: 'inventory',
        tenantId,
      });
      const createProposal = Effect.fn('SourceRetryTest.proposal')(function* createProposal(
        revision: number,
        coverageRelation: 'MISSING' | 'UNKNOWN' | 'INCLUDES',
      ) {
        const assertionId = yield* nextId;
        return yield* Schema.decodeUnknownEffect(InventorySourceAssertionProposalSchema)({
          assertionId,
          businessObservedAt: observedAt,
          coverage:
            coverageRelation === 'MISSING'
              ? []
              : [{ assertionId, effectId, ownerEvidenceRef: 'erp:applied-receipt', relation: coverageRelation }],
          customerConfigurationId,
          factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
          issuer,
          itemExternalKey: externalKey('ITEM'),
          locationExternalKey: externalKey('LOCATION'),
          orderingEvidence: { _tag: 'SOURCE_REVISION', revision: String(revision) },
          ownerEvidenceRef: `erp:snapshot:${revision}`,
          positionRef,
          quantity: { amount: '8', unitRef },
          receivedAt: '2026-09-24T11:00:00.000Z',
          sourceReference: `erp:snapshot:${revision}`,
        });
      });
      yield* fixture
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* produceInventorySourceSetup() {
            yield* inventoryBackendConfigurationPersistenceForScope(transaction, scope).insertInitial(configuration);
            yield* makeDrizzleStockItemRepository(transaction).insert(
              yield* Schema.decodeUnknownEffect(StockItemSchema)({
                createdAt: selectedAt,
                exactSelectionMeaning: { id: `catalog-selection:${itemId}`, kind: 'PRODUCT_VARIANT' },
                lifecycle: 'CURRENT',
                retiredAt: null,
                revision: 1,
                stockItemRef: itemRef,
                unitRef,
              }),
            );
            yield* stockLocationPersistenceForScope(transaction, scope).create(
              yield* Schema.decodeUnknownEffect(StockLocationSchema)({
                displayName: 'Source retry fixture',
                lifecycle: { _tag: 'ACTIVE' },
                operationalScope: { _tag: 'LOGICAL_AGGREGATE', physicalSiteKeys: [] },
                ref: locationRef,
                revision: 1,
              }),
            );
            yield* stockPositionPersistenceForScope(transaction, scope).create(
              yield* Schema.decodeUnknownEffect(StockPositionSchema)({
                createdAt: selectedAt,
                endedAt: null,
                lifecycle: 'CURRENT',
                onHand: { _tag: 'UNKNOWN', meaning: 'ON_HAND', ownerConfigurationRef: configurationRef, unitRef },
                ref: positionRef,
                revision: 1,
                scope: { customerConfigurationId, stockItemRef: itemRef, stockLocationRef: locationRef, unitRef },
              }),
            );
            const correlations = externalStockCorrelationPersistenceForScope(transaction, scope);
            yield* correlations.insertCurrent(
              yield* Schema.decodeUnknownEffect(ExternalStockCorrelationSchema)({
                confirmedAt: selectedAt,
                correlationRef: {
                  moduleId: 'commerce.inventory',
                  resourceId: itemCorrelationId,
                  resourceType: 'commerce.inventory.external-stock-correlation',
                  tenantId,
                },
                effectivePeriod: { from: selectedAt, to: null },
                externalKey: externalKey('ITEM'),
                lifecycle: 'CURRENT',
                ownerEvidenceRef: 'erp:item-correlation',
                revision: 1,
                target: { _tag: 'STOCK_ITEM', ref: itemRef },
              }),
            );
            yield* correlations.insertCurrent(
              yield* Schema.decodeUnknownEffect(ExternalStockCorrelationSchema)({
                confirmedAt: selectedAt,
                correlationRef: {
                  moduleId: 'commerce.inventory',
                  resourceId: locationCorrelationId,
                  resourceType: 'commerce.inventory.external-stock-correlation',
                  tenantId,
                },
                effectivePeriod: { from: selectedAt, to: null },
                externalKey: externalKey('LOCATION'),
                lifecycle: 'CURRENT',
                ownerEvidenceRef: 'erp:location-correlation',
                revision: 1,
                target: { _tag: 'STOCK_LOCATION', ref: locationRef },
              }),
            );
            const request = yield* Schema.decodeUnknownEffect(PhysicalStockEffectRequestSchema)({
              actionInvocationId: yield* nextId,
              backend: 'external_business_system',
              backendConfigurationRef: configurationRef,
              backendId: issuer.backendId,
              customerConfigurationId,
              effectId,
              kind: 'RECEIPT',
              legalEntityId: fixture.legalEntityId,
              positionRef,
              quantity: { amount: '2', unitRef },
              reason: { code: 'SOURCE_RETRY_CONTROL', reference: 'native-owner-fixture' },
              requestedAt: selectedAt,
              stockItemRef: itemRef,
              stockLocationRef: locationRef,
            });
            const effects = physicalStockEffectPersistenceForScope(transaction, scope);
            yield* effects.createOrRead(request);
            yield* effects.saveTerminal(
              request,
              yield* Schema.decodeUnknownEffect(AppliedPhysicalStockEffectSchema)({
                _tag: 'APPLIED',
                evidence: {
                  appliedAt: '2026-09-24T09:30:00.000Z',
                  backend: 'external_business_system',
                  backendConfigurationRef: configurationRef,
                  backendEvidenceRef: 'erp:applied-receipt',
                  backendId: issuer.backendId,
                  effectId,
                  issuer: issuer.backendId,
                  kind: 'RECEIPT',
                  positionRef,
                  quantity: request.quantity,
                },
                request,
              }),
            );
          }),
        )
        .pipe(Effect.provide(ownerRuntimeLayer));

      yield* fixture
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* verifyImportOwnerBoundary() {
            // The owner rule is about one Position (O70): Core resolves these facts from the decoded
            // payload, the overlay locks that row and checks its on-hand authority (O20/O31).
            const stockItems = yield* Layer.build(stockItemRepositoryLayerForTransaction(transaction));
            const boundItem = yield* Context.get(stockItems, StockItemRepository).findById(tenantId, itemId);
            assert(Option.isSome(boundItem));
            expect(boundItem.value.stockItemRef).toEqual(itemRef);
            const positionFacts = {
              inventoryPositionModuleId: 'commerce.inventory',
              inventoryPositionResourceId: positionId,
              inventoryPositionResourceType: 'commerce.inventory.stock-position',
              inventoryPositionTenantId: tenantId,
            } as const;
            const input: OwnerAuthorizationInput = {
              capabilityKey: 'commerce.inventory.source-assertion.import',
              operation: 'action',
              operationAt: composition.observedAt,
              operationKey: importSourceAssertionAction.descriptor.actionKey,
              ownerFacts: positionFacts,
              owningModuleKey: 'commerce.inventory',
              scope,
              targets: [],
            };
            expect(yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, input)).toBe('allowed');
            // Another capability, another entrypoint and a read are all outside this owner rule.
            expect(
              yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, {
                ...input,
                capabilityKey: 'commerce.inventory.stock-position.correct',
              }),
            ).toBe('allowed');
            expect(
              yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, {
                ...input,
                operation: 'read',
              }),
            ).toBe('allowed');
            expect(
              yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, {
                ...input,
                owningModuleKey: 'pricing.price-group-catalog',
              }),
            ).toBe('allowed');
            // The facts name the record; without them the owner cannot admit the import.
            const { ownerFacts: _positionFacts, ...factslessInput } = input;
            expect(yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, factslessInput)).toBe(
              'unavailable',
            );
            // Pricing's own business rule never applies here: a legacy target fails closed.
            expect(
              yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, {
                ...input,
                targets: [
                  {
                    kind: 'module',
                    moduleId: 'commerce.inventory',
                  },
                ],
              }),
            ).toBe('allowed');
            // A Company scope is not this Tenant-global ingest authority.
            expect(
              yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, {
                ...input,
                scope: { ...scope, legalEntityId: fixture.legalEntityId },
              }),
            ).toBe('unavailable');
            // Facts of another Tenant are refused, never re-read as the trusted Tenant.
            expect(
              yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, {
                ...input,
                ownerFacts: { ...positionFacts, inventoryPositionTenantId: yield* nextId },
              }),
            ).toBe('denied');
            // A malformed Position reference cannot be decoded, so it is refused.
            expect(
              yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, {
                ...input,
                ownerFacts: { ...positionFacts, inventoryPositionResourceType: 'commerce.inventory.stock-item' },
              }),
            ).toBe('denied');
            // An unknown Position has no owner row to lock.
            expect(
              yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, {
                ...input,
                ownerFacts: { ...positionFacts, inventoryPositionResourceId: yield* nextId },
              }),
            ).toBe('unavailable');
          }),
        )
        .pipe(Effect.provide(ownerRuntimeLayer));

      // v2 asks the one access gate, not a legacy SpiceDB tuple: the Import capability is decided
      // by the read/Action carrier in the trusted scope (CUTOVER-PLAN §3.2).
      const keyPair = yield* Effect.sync(() => generateKeyPairSync('ed25519'));
      const kid = 'inventory-source-retry';
      const tokenIssuer = 'https://disposable-shell.ontos.test';
      const jwks = JSON.stringify({
        keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
      });
      const authorization = Effect.fn('SourceRetryTest.authorization')(function* authorization(
        actor = fixture.manager,
      ) {
        const tokenId = yield* nextId;
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(
          JSON.stringify({
            aud: 'inventory',
            compositionRevision: composition.composition.revision,
            exp: now + 300,
            iat: now,
            iss: tokenIssuer,
            jti: tokenId,
            principal: actor,
            sub: actor.principalId,
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
        .add(inventoryApi.groups.importSourceAssertionAction)
        .add(inventoryApi.groups.inventorySourceImportReceipt);
      const handlers = Layer.mergeAll(importSourceAssertionActionApiLive, inventorySourceImportReceiptReadApiLive).pipe(
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
      const nativeFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.has('authorization')).toBe(true);
        expect(request.headers.has('x-correlation-id')).toBe(true);
        request.headers.set('x-trace-id', 'inventory-native-trace');
        return app.handler(request, emptyContext);
      };
      const missingKeyFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        request.headers.delete('idempotency-key');
        return nativeFetch(request);
      };
      const importItems = Effect.fn('SourceRetryTest.importItems')(function* importItems(
        items: readonly (typeof InventorySourceAssertionProposalSchema.Type)[],
        key?: string,
        fetcher?: typeof fetch,
      ) {
        return yield* requireExecutionResult(
          ImportSourceAssertionResultSchema,
          executeImportSourceAssertionWithAuthorization(
            { authorizationTargetRef: items[0]?.positionRef ?? positionRef, items },
            yield* authorization(),
            yield* nextId,
            {
              baseUrl: 'https://inventory.ontos.test',
              compositionRevision: composition.composition.revision,
              idempotencyKey: key ?? (yield* nextId),
            },
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetcher ?? nativeFetch)),
        );
      });
      const readReceipt = Effect.fn('SourceRetryTest.readReceipt')(function* readReceipt(
        proposal: typeof InventorySourceAssertionProposalSchema.Type,
        invocationId: string,
        itemIndex = 0,
      ) {
        return yield* executeInventorySourceImportReceiptWithAuthorization(
          { actionInvocationId: InventorySourceImportActionInvocationIdSchema.make(invocationId), itemIndex, proposal },
          yield* authorization(),
          yield* nextId,
          { baseUrl: 'https://inventory.ontos.test', compositionRevision: composition.composition.revision },
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      });
      const observe = () =>
        fixture
          .prepareOwner((transaction) =>
            Effect.all(
              {
                assertions: transaction
                  .select()
                  .from(inventorySourceAssertions)
                  .where(eq(inventorySourceAssertions.tenantId, tenantId)),
                effects: transaction
                  .select()
                  .from(inventoryPhysicalStockEffects)
                  .where(eq(inventoryPhysicalStockEffects.tenantId, tenantId)),
                ledger: transaction
                  .select()
                  .from(inventorySourceImportLedger)
                  .where(eq(inventorySourceImportLedger.tenantId, tenantId)),
              },
              { concurrency: 1 },
            ),
          )
          .pipe(Effect.provide(ownerRuntimeLayer));
      const original = yield* createProposal(1, 'MISSING');
      const malformed = yield* importItems([original], '').pipe(Effect.flip);
      expect(Schema.is(ImportSourceAssertionActionInvalidProblemSchema)(malformed)).toBe(true);
      const missing = yield* importItems([original], undefined, missingKeyFetch).pipe(Effect.flip);
      expect(Schema.is(ImportSourceAssertionActionPreconditionProblemSchema)(missing)).toBe(true);
      const firstKey = yield* nextId;
      const first = yield* importItems([original], firstKey);
      expect(first.items).toMatchObject([
        { reason: 'MATERIAL_EFFECT_COVERAGE_MISSING', reconciliationRequired: true, status: 'INDETERMINATE' },
      ]);
      const committed = yield* observe();
      expect(committed.assertions).toHaveLength(1);
      expect(committed.ledger).toHaveLength(1);
      expect(committed.effects).toMatchObject([{ state: 'APPLIED' }]);
      // Internal C14 fixture: the public governed read recovers the exact committed original
      // without a new Action, and a changed proposal never retargets that receipt.
      const originalCommit = yield* importItems([original], firstKey).pipe(Effect.flip);
      assert(Schema.is(ImportSourceAssertionActionAlreadyCommittedProblemSchema)(originalCommit));
      const originalReceipt = yield* readReceipt(original, originalCommit.invocationId);
      assert(Schema.is(InventorySourceImportReceiptResponseSchema.members[0])(originalReceipt));
      expect(originalReceipt.receipt.outcome).toEqual(first.items[0]);
      expect(originalReceipt.receipt.proposal).toEqual(original);
      expect((yield* observe()).ledger).toHaveLength(1);
      const repeated = yield* importItems([original]);
      expect(repeated.items).toEqual(first.items);
      expect((yield* observe()).assertions).toEqual(committed.assertions);
      const sameKey = yield* importItems([original], firstKey).pipe(Effect.flip);
      expect(Schema.is(ImportSourceAssertionActionAlreadyCommittedProblemSchema)(sameKey)).toBe(true);
      expect((yield* observe()).ledger).toHaveLength(2);
      const changed = yield* Schema.decodeUnknownEffect(InventorySourceAssertionProposalSchema)({
        ...original,
        quantity: { ...original.quantity, amount: '999' },
      });
      expect((yield* importItems([changed])).items).toMatchObject([
        { reason: 'ASSERTION_ID_CONFLICT', status: 'REJECTED' },
      ]);
      const next = yield* createProposal(2, 'INCLUDES');
      const mixedKey = yield* nextId;
      const mixed = yield* importItems([original, next], mixedKey);
      expect(mixed.items).toMatchObject([{ status: 'INDETERMINATE' }, { status: 'ACCEPTED' }]);
      expect((yield* importItems([next])).items).toMatchObject([
        { duplicateOfAssertionId: next.assertionId, status: 'DUPLICATE' },
      ]);
      const mixedCommit = yield* importItems([original, next], mixedKey).pipe(Effect.flip);
      assert(Schema.is(ImportSourceAssertionActionAlreadyCommittedProblemSchema)(mixedCommit));
      const acceptedReceipt = yield* readReceipt(next, mixedCommit.invocationId, 1);
      assert(Schema.is(InventorySourceImportReceiptResponseSchema.members[0])(acceptedReceipt));
      expect(acceptedReceipt.receipt.outcome.status).toBe('ACCEPTED');
      const mismatchedReceipt = yield* readReceipt(
        { ...next, sourceReference: 'revised-mapping-source' },
        mixedCommit.invocationId,
        1,
      );
      expect(Schema.is(InventorySourceImportReceiptResponseSchema.members[1])(mismatchedReceipt)).toBe(true);
      const stale = yield* createProposal(0, 'INCLUDES');
      expect((yield* importItems([stale])).items).toMatchObject([
        { currentAssertionId: next.assertionId, status: 'STALE' },
      ]);
      const acceptedAfterStale = yield* readReceipt(next, mixedCommit.invocationId, 1);
      expect(acceptedAfterStale).toEqual(acceptedReceipt);
      const race = yield* createProposal(3, 'UNKNOWN');
      const raced = yield* Effect.all([importItems([race]), importItems([race])], { concurrency: 2 });
      expect(raced.map((result) => result.items[0]?.status)).toEqual(['INDETERMINATE', 'INDETERMINATE']);
      expect((yield* observe()).assertions.filter((value) => value.assertionId === race.assertionId)).toHaveLength(1);
      const rolledBack = yield* createProposal(4, 'MISSING');
      const absentReceipt = yield* readReceipt(rolledBack, yield* nextId);
      expect(Schema.is(InventorySourceImportReceiptResponseSchema.members[1])(absentReceipt)).toBe(true);
      fixture.faultNextTransaction('rollback');
      const rollback = yield* importItems([race, rolledBack]).pipe(Effect.flip);
      expect(Schema.is(ImportSourceAssertionActionUnavailableProblemSchema)(rollback)).toBe(true);
      expect((yield* observe()).assertions.some((value) => value.assertionId === rolledBack.assertionId)).toBe(false);
      expect((yield* importItems([rolledBack])).items).toMatchObject([{ status: 'INDETERMINATE' }]);
      const beforeSqlAbort = yield* observe();
      const sqlAbort = yield* fixture
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* nativeSqlAbortControl() {
            const assertions = inventorySourceAssertionPersistenceForScope(transaction, scope);
            const stored = yield* assertions.findById(original.assertionId);
            assert(Option.isSome(stored));
            const duplicate = yield* assertions.append(stored.value).pipe(Effect.flip);
            expect(Option.isSome(findPostgresFailure(duplicate, ({ code }) => code === '23505'))).toBe(true);
            expect(
              yield* importSourceAssertionOwnerAuthorizationOverlay.authorize(transaction, {
                capabilityKey: 'commerce.inventory.source-assertion.import',
                operation: 'action',
                operationAt: composition.observedAt,
                operationKey: importSourceAssertionAction.descriptor.actionKey,
                owningModuleKey: 'commerce.inventory',
                scope,
                targets: [],
              }),
            ).toBe('unavailable');

            const ledger = inventorySourceImportLedgerPersistenceForScope(transaction, scope);
            const abort = yield* ledger
              .append({
                actionInvocationId: yield* Schema.decodeUnknownEffect(InventorySourceImportActionInvocationIdSchema)(
                  yield* nextId,
                ),
                itemIndex: 0,
                outcome: (yield* Schema.decodeUnknownEffect(InventorySourceImportLedgerEntrySchema)({
                  actionInvocationId: yield* nextId,
                  itemIndex: 0,
                  outcome: first.items[0],
                  proposal: original,
                })).outcome,
                proposal: original,
              })
              .pipe(Effect.flip);
            return yield* Effect.fail(abort);
          }),
        )
        .pipe(Effect.provide(ownerRuntimeLayer), Effect.flip);
      expect(Option.isSome(findPostgresFailure(sqlAbort, ({ code }) => code === '25P02'))).toBe(true);
      expect(yield* observe()).toEqual(beforeSqlAbort);
      const evidence = yield* fixture.evidence(coreEvidenceExecutor);
      expect(evidence.invocations.filter((value) => value.status === 'succeeded')).toHaveLength(9);
      // The public owner projection is proven against Core's actual persisted invocation hash.
      // In particular, the Position owner fact must not be substituted as a Core record target.
      const requestIdentity = yield* prepareImportSourceAssertionRequestIdentity({
        authorizationTargetRef: original.positionRef,
        items: [original],
      });
      expect(requestIdentity.actionKey).toBe(importSourceAssertionAction.descriptor.actionKey);
      expect(requestIdentity.schemaVersion).toBe(importSourceAssertionAction.descriptor.schemaVersion);
      expect(requestIdentity.target).toEqual({});
      const originalInvocation = evidence.invocations.find(
        ({ actionInvocationId }) => actionInvocationId === originalCommit.invocationId,
      );
      assert(originalInvocation !== undefined);
      expect(originalInvocation.requestHash).toBe(
        computeActionRequestHash({ ...requestIdentity, principal: fixture.manager }),
      );

      expect(evidence.invocations.some((value) => value.traceId === 'inventory-native-trace')).toBe(true);
      expect(evidence.invocations.filter((value) => value.status === 'received')).toHaveLength(1);
      expect((yield* observe()).assertions.find((value) => value.assertionId === original.assertionId)).toEqual(
        committed.assertions[0],
      );
    }).pipe(Effect.provide(NodeCrypto.layer), Effect.provide(NodeServices.layer)),
);
