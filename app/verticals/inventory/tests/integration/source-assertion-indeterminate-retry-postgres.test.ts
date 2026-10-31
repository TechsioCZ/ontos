import { Reactivity } from 'effect/reactivity';
import { PgClient } from '@effect/sql-pg';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  findPostgresFailure,
  loadDatabaseConnectionPair,
  makeBusinessPermissionRelationshipMutationLive,
  makeContextAccessLive,
  toBusinessPermissionAccessKey,
  makeContextPermissionRelationshipMutationLive,
} from '@app/core-runtime';
import type { OwnerAuthorizationInput } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { eq } from 'drizzle-orm';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
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
import { makeDrizzleStockItemRepository } from '../../src/persistence/stock-item-repository.ts';
import { stockLocationPersistenceForScope } from '../../src/persistence/stock-location-repository.ts';
import { stockPositionPersistenceForScope } from '../../src/persistence/stock-position-repository.ts';
import {
  authorizeImportSourceAssertionOwner,
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
      const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      const composition = yield* makeApplicationCompositionSnapshotFixture(
        ['inventory'],
        ultramodernApiMarker.buildMarker,
      );
      const now = Math.floor(DateTime.toEpochMillis(composition.observedAt) / 1000);
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionKeys: [importSourceAssertionAction.descriptor.actionKey],
          adminConnectionString: Redacted.make(connections.admin.connectionString),
          allowedAudiences: ['inventory'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.composition.revision,
          moduleKeys: ['commerce.inventory'],
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
            const input: OwnerAuthorizationInput = {
              operation: 'action',
              operationAt: composition.observedAt,
              operationKey: importSourceAssertionAction.descriptor.actionKey,
              owningModuleKey: 'commerce.inventory',
              scope,
              targets: [
                {
                  kind: 'business_permission',
                  permission: 'inventory.migration.manage',
                  target: {
                    kind: 'inventory_resource',
                    resource: {
                      moduleId: 'commerce.inventory',
                      resourceId: positionId,
                      resourceType: 'commerce.inventory.stock-position',
                    },
                    tenantId,
                  },
                },
              ],
            };
            expect(yield* authorizeImportSourceAssertionOwner(transaction, input)).toBe('allowed');
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                operationKey: 'commerce.inventory.stock-issue',
              }),
            ).toBe('unavailable');
            expect(yield* authorizeImportSourceAssertionOwner(transaction, { ...input, targets: [] })).toBe(
              'unavailable',
            );
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                operationKey: 'commerce.inventory.core-neutral-control',
                targets: [],
              }),
            ).toBe('allowed');
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                operation: 'read',
                operationKey: 'commerce.inventory.core-neutral-control',
                targets: [{ kind: 'module', moduleId: 'commerce.inventory' }],
              }),
            ).toBe('allowed');
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                operationKey: 'commerce.inventory.core-neutral-control',
                targets: [{ kind: 'tenant', permission: 'access', tenantId }],
              }),
            ).toBe('allowed');
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                scope: { ...scope, legalEntityId: fixture.legalEntityId },
              }),
            ).toBe('denied');
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                targets: [...input.targets, ...input.targets],
              }),
            ).toBe('unavailable');
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                targets: [{ kind: 'module', moduleId: 'commerce.inventory' }],
              }),
            ).toBe('unavailable');
            const [target] = input.targets;
            assert(
              target !== undefined &&
                target.kind === 'business_permission' &&
                target.target.kind === 'inventory_resource',
            );
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                targets: [{ ...target, permission: 'inventory.stock.issue' }],
              }),
            ).toBe('denied');
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                targets: [{ ...target, target: { ...target.target, tenantId: yield* nextId } }],
              }),
            ).toBe('denied');
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                targets: [
                  {
                    ...target,
                    target: {
                      ...target.target,
                      resource: { ...target.target.resource, resourceType: 'commerce.inventory.stock-item' },
                    },
                  },
                ],
              }),
            ).toBe('denied');
            expect(
              yield* authorizeImportSourceAssertionOwner(transaction, {
                ...input,
                targets: [
                  {
                    ...target,
                    target: { ...target.target, resource: { ...target.target.resource, resourceId: yield* nextId } },
                  },
                ],
              }),
            ).toBe('unavailable');
          }),
        )
        .pipe(Effect.provide(ownerRuntimeLayer));

      const businessPermissions = yield* makeBusinessPermissionRelationshipMutationLive();
      const contextPermissions = yield* makeContextPermissionRelationshipMutationLive();
      const principal = { principalId: fixture.manager.principalId, tenantId };
      const businessTarget = {
        kind: 'inventory_resource' as const,
        resource: {
          moduleId: 'commerce.inventory' as const,
          resourceId: positionId,
          resourceType: 'commerce.inventory.stock-position',
        },
        tenantId,
      };
      const moduleTarget = { moduleId: 'commerce.inventory', permission: 'module.access' as const };
      yield* businessPermissions.mutate({
        operation: 'grant',
        permission: 'inventory.migration.manage',
        principal,
        target: businessTarget,
      });
      yield* contextPermissions.mutate({ operation: 'grant', principal, target: moduleTarget, tenantId });
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [
            businessPermissions.mutate({
              operation: 'revoke',
              permission: 'inventory.migration.manage',
              principal,
              target: businessTarget,
            }),
            contextPermissions.mutate({ operation: 'revoke', principal, target: moduleTarget, tenantId }),
          ],
          { concurrency: 1 },
        ).pipe(Effect.asVoid, Effect.orDie),
      );

      const contextAccess = yield* makeContextAccessLive();
      assert(contextAccess.businessPermissions !== undefined);
      const businessTargetCheck = { permission: 'inventory.migration.manage' as const, target: businessTarget };
      expect(yield* contextAccess.businessPermissions({ principal, targets: [businessTargetCheck] })).toEqual([
        { decision: 'allowed', key: toBusinessPermissionAccessKey(businessTargetCheck) },
      ]);
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
      const api = HttpApi.make('InventoryApi').add(inventoryApi.groups.importSourceAssertionAction);
      const handlers = importSourceAssertionActionApiLive.pipe(
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
        return yield* executeImportSourceAssertionWithAuthorization(
          { authorizationTargetRef: items[0]?.positionRef ?? positionRef, items },
          yield* authorization(),
          yield* nextId,
          {
            baseUrl: 'https://inventory.ontos.test',
            compositionRevision: composition.composition.revision,
            idempotencyKey: key ?? (yield* nextId),
          },
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetcher ?? nativeFetch));
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
      const mixed = yield* importItems([original, next]);
      expect(mixed.items).toMatchObject([{ status: 'INDETERMINATE' }, { status: 'ACCEPTED' }]);
      expect((yield* importItems([next])).items).toMatchObject([
        { duplicateOfAssertionId: next.assertionId, status: 'DUPLICATE' },
      ]);
      const race = yield* createProposal(3, 'UNKNOWN');
      const raced = yield* Effect.all([importItems([race]), importItems([race])], { concurrency: 2 });
      expect(raced.map((result) => result.items[0]?.status)).toEqual(['INDETERMINATE', 'INDETERMINATE']);
      expect((yield* observe()).assertions.filter((value) => value.assertionId === race.assertionId)).toHaveLength(1);
      const rolledBack = yield* createProposal(4, 'MISSING');
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
              yield* authorizeImportSourceAssertionOwner(transaction, {
                operation: 'action',
                operationAt: composition.observedAt,
                operationKey: importSourceAssertionAction.descriptor.actionKey,
                owningModuleKey: 'commerce.inventory',
                scope,
                targets: [
                  { kind: 'business_permission', permission: 'inventory.migration.manage', target: businessTarget },
                ],
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
      expect(evidence.invocations.filter((value) => value.status === 'succeeded')).toHaveLength(8);
      expect(evidence.invocations.some((value) => value.traceId === 'inventory-native-trace')).toBe(true);
      expect(evidence.invocations.filter((value) => value.status === 'received')).toHaveLength(1);
      expect((yield* observe()).assertions.find((value) => value.assertionId === original.assertionId)).toEqual(
        committed.assertions[0],
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
);
