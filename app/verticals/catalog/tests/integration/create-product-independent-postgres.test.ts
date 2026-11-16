import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
  findPostgresFailure,
  makeContextPermissionRelationshipMutationLive,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { createCatalogDeniedAccess } from '../support/live-access-authority.ts';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { and, eq } from 'drizzle-orm';
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
import { assert, expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { createProductActionApiLive } from '../../api/create-product-action-server.ts';
import { createProductRecoveryReadApiLive } from '../../api/create-product-recovery-read-server.ts';
import { productHistoryReadApiLive } from '../../api/product-history-read-server.ts';
import { variantHistoryReadApiLive } from '../../api/variant-history-read-server.ts';
import { CreateProductPayloadSchema, CreateProductResultSchema } from '../../shared/actions/create-product.ts';
import {
  CreateProductActionAlreadyCommittedProblemSchema,
  CreateProductActionCommitIndeterminateProblemSchema,
  CreateProductActionConflictProblemSchema,
  CreateProductActionForbiddenProblemSchema,
  CreateProductActionIneligibleProblemSchema,
  CreateProductActionUnavailableProblemSchema,
} from '../../shared/apis/create-product-action.ts';
import { ProductHistoryResponseSchema } from '../../shared/apis/product-history.ts';
import { VariantHistoryResponseSchema } from '../../shared/apis/variant-history.ts';
import { catalogApi } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { requireExecutionResult } from '../support/action-execution-result.ts';
import { createProductAction } from '../../src/actions/create-product.action.ts';
import { createVariantRecoveryReadApiLive } from '../../api/create-variant-recovery-read-server.ts';
import { createVariantActionApiLive } from '../../api/create-variant-action-server.ts';
import { createVariantAction } from '../../src/actions/create-variant.action.ts';
import { executeCreateVariantWithAuthorization } from '../../src/api/create-variant-action-client.ts';
import { CreateVariantPayloadSchema, CreateVariantResultSchema } from '../../shared/actions/create-variant.ts';
import type { CatalogSourceProductsRequest } from '../../shared/apis/catalog-source-products.ts';
import { catalogSourceProductsReadApiLive } from '../../api/catalog-source-products-read-server.ts';
import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import { correctProductActionApiLive } from '../../api/correct-product-action-server.ts';
import { updateProductActionApiLive } from '../../api/update-product-action-server.ts';
import { correctProductAction } from '../../src/actions/correct-product.action.ts';
import { updateProductAction } from '../../src/actions/update-product.action.ts';
import { executeCorrectProductWithAuthorization } from '../../src/api/correct-product-action-client.ts';
import { executeUpdateProductWithAuthorization } from '../../src/api/update-product-action-client.ts';
import { CorrectProductPayloadSchema, CorrectProductResultSchema } from '../../shared/actions/correct-product.ts';
import { UpdateProductPayloadSchema, UpdateProductResultSchema } from '../../shared/actions/update-product.ts';
import {
  createProductRequestIdentity,
  createVariantRequestIdentity,
  updateProductRequestIdentity,
  correctProductRequestIdentity,
  bindInitialVariantSourceRequestIdentity,
} from '../../shared/domain/native-action-request-identity.ts';
import { bindInitialVariantSourceRecoveryReadApiLive } from '../../api/bind-initial-variant-source-recovery-read-server.ts';
import {
  BindInitialVariantSourceActionAlreadyCommittedProblemSchema,
  BindInitialVariantSourceActionCommitIndeterminateProblemSchema,
  BindInitialVariantSourceActionConflictProblemSchema,
} from '../../shared/apis/bind-initial-variant-source-action.ts';
import { bindInitialVariantSourceActionApiLive } from '../../api/bind-initial-variant-source-action-server.ts';
import { bindInitialVariantSourceAction } from '../../src/actions/bind-initial-variant-source.action.ts';
import { executeBindInitialVariantSourceWithAuthorization } from '../../src/api/bind-initial-variant-source-action-client.ts';
import { BindInitialVariantSourceResultSchema } from '../../shared/actions/bind-initial-variant-source.ts';
import {
  CatalogSourceProductsRequestSchema,
  CatalogSourceProductsResponseSchema,
} from '../../shared/apis/catalog-source-products.ts';
import { catalogRegistration } from '../../vertical.registration.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import { executeCreateProductWithAuthorization } from '../../src/api/create-product-action-client.ts';
import {
  catalogResultSnapshots,
  catalogSourceCorrelations,
  productRevisions,
  productVariantRevisions,
  productVariants,
  products,
} from '../../src/database/schema.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());

it.live(
  'commits ordinary create without invented reason and preserves strict successor, history and retry boundaries',
  () =>
    Effect.gen(function* independentCreatePostgres() {
      const composition = yield* makeApplicationCompositionSnapshotFixture(
        ['catalog'],
        ultramodernApiMarker.buildMarker,
      );
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: composition,
        mode: 'schema-only',
        purpose: 'stabilization-1196-product-create',
      });
      yield* Effect.logInfo('1196 isolated clone ready');
      expect(isolated.connections.runtime.database).toBe(isolated.connections.admin.database);
      expect(isolated.connections.runtime.user).not.toBe(isolated.connections.admin.user);
      const now = Math.floor(DateTime.toEpochMillis(composition.observedAt) / 1000);
      // This public fixture owns real PG/SpiceDB and commit fault controls. Its explicit
      // Action composition-lock seam does not prove production Action publication/fence
      // acceptance. Public Reads use the genuine initial authority published in this
      // scope-owned schema-only database; the source authority is never replaced.
      const adminContext = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      );
      const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          access: 'allowed',
          actionKeys: [
            createProductAction.descriptor.actionKey,
            bindInitialVariantSourceAction.descriptor.actionKey,
            createVariantAction.descriptor.actionKey,
            correctProductAction.descriptor.actionKey,
            updateProductAction.descriptor.actionKey,
          ],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          allowedAudiences: ['catalog'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.composition.revision,
          moduleKeys: ['commerce.catalog'],
          ownerRegistration: catalogRegistration,
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      // The generic live fixture grants execution to its entire Tenant membership.
      // A second genuine Tenant with no Action grants is the missing-executor control.
      const ungranted = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionKeys: [],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          allowedAudiences: ['catalog'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.composition.revision,
          moduleKeys: ['commerce.catalog'],
          ownerRegistration: catalogRegistration,
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      const { tenantId } = fixture;
      // The one access gate this suite scripts (the native database carries no v2 access intent and
      // reaches no engine), plus the per-principal refusal it names (see `live-access-authority`).
      const deniedAccess = createCatalogDeniedAccess();
      const accessLayer = fixture.layer.pipe(Layer.provide(deniedAccess.layer));
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      const principal = { principalId: fixture.manager.principalId, tenantId };
      const targets = [
        { moduleId: 'commerce.catalog', permission: 'module.access' as const },
        { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.create-product-recovery' as const },
        { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.catalog-source-products' as const },
        {
          moduleId: 'commerce.catalog',
          permission: 'commerce.catalog.read.bind-initial-variant-source-recovery' as const,
        },
        { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.product-history' as const },
        { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.variant-history' as const },
      ];
      yield* Effect.forEach(
        targets,
        (target) => permissions.mutate({ operation: 'grant', principal, target, tenantId }),
        { concurrency: 1 },
      );
      yield* Effect.addFinalizer(() =>
        Effect.forEach(targets, (target) => permissions.mutate({ operation: 'revoke', principal, target, tenantId }), {
          concurrency: 1,
        }).pipe(Effect.asVoid, Effect.orDie),
      );
      const keyPair = yield* Effect.sync(() => generateKeyPairSync('ed25519'));
      const kid = 'catalog-independent-create';
      const tokenIssuer = 'https://disposable-shell.ontos.test';
      const jwks = JSON.stringify({
        keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid, use: 'sig' }],
      });
      const authorization = Effect.fn('IndependentCreate.authorization')(function* authorization(
        actor = fixture.manager,
      ) {
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(
          JSON.stringify({
            aud: 'catalog',
            compositionRevision: composition.composition.revision,
            exp: now + 300,
            iat: now,
            iss: tokenIssuer,
            jti: yield* nextId,
            principal: actor,
            sub: actor.principalId,
            targetBuildMarker: ultramodernApiMarker.buildMarker,
            ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
          }),
        ).toString('base64url');
        const content = `${header}.${payload}`;
        return `Bearer ${content}.${sign(null, Buffer.from(content), keyPair.privateKey).toString('base64url')}`;
      });
      // Catalog production redemption is unconfigured. Only this configured test store
      // is substituted; every assertion is verified and consumed exactly once here.
      const redeemed = new Set<string>();
      const redemption = Layer.succeed(GatewayAssertionRedemptionService, {
        consume: ({ jti }) =>
          Effect.suspend(() => {
            if (redeemed.has(jti)) {
              return Effect.fail(new GatewayAssertionReplayError({ reason: 'Assertion already redeemed' }));
            }
            redeemed.add(jti);
            return Effect.void;
          }),
      });
      const api = HttpApi.make('CatalogApi')
        .add(catalogApi.groups.createProductAction)
        .add(catalogApi.groups.createProductRecovery)
        .add(catalogApi.groups.catalogSourceProducts)
        .add(catalogApi.groups.createVariantAction)
        .add(catalogApi.groups.createVariantRecovery)
        .add(catalogApi.groups.correctProductAction)
        .add(catalogApi.groups.updateProductAction)
        .add(catalogApi.groups.bindInitialVariantSourceAction)
        .add(catalogApi.groups.bindInitialVariantSourceRecovery)
        .add(catalogApi.groups.productHistory)
        .add(catalogApi.groups.variantHistory);
      const handlers = Layer.mergeAll(
        createProductActionApiLive,
        createProductRecoveryReadApiLive,
        catalogSourceProductsReadApiLive,
        createVariantActionApiLive,
        createVariantRecoveryReadApiLive,
        correctProductActionApiLive,
        updateProductActionApiLive,
        bindInitialVariantSourceActionApiLive,
        bindInitialVariantSourceRecoveryReadApiLive,
        productHistoryReadApiLive,
        variantHistoryReadApiLive,
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            ActionPrincipalVerifierLive,
            makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
          ).pipe(Layer.provide(ActiveApplicationCompositionSourceLive), Layer.provide(FetchHttpClient.layer)),
        ),
        Layer.provide(redemption),
        Layer.provide(accessLayer),
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
              Layer.provideMerge(accessLayer),
              Layer.provide(HttpServer.layerServices),
              Layer.provide(NodeCrypto.layer),
            ),
            { disableLogger: true },
          ),
        ),
        (value) => Effect.promise(value.dispose.bind(value)).pipe(Effect.orDie),
      );
      const nativeFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), emptyContext);
      const create = Effect.fn('IndependentCreate.create')(function* create(
        payload: typeof CreateProductPayloadSchema.Type,
        key?: string,
        actor = fixture.manager,
      ) {
        return yield* requireExecutionResult(
          CreateProductResultSchema,
          executeCreateProductWithAuthorization(payload, yield* authorization(actor), yield* nextId, {
            baseUrl: 'https://catalog.ontos.test',
            compositionRevision: composition.composition.revision,
            idempotencyKey: key ?? (yield* nextId),
          }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch)),
        );
      });
      const observe = () =>
        fixture
          .prepareOwner((transaction) =>
            Effect.all(
              {
                products: transaction
                  .select()
                  .from(products)
                  .where(eq(products.tenantId, tenantId))
                  .orderBy(products.productId),
                revisions: transaction
                  .select()
                  .from(productRevisions)
                  .where(eq(productRevisions.tenantId, tenantId))
                  .orderBy(productRevisions.productRevisionId),
                snapshots: transaction
                  .select()
                  .from(catalogResultSnapshots)
                  .where(eq(catalogResultSnapshots.tenantId, tenantId))
                  .orderBy(catalogResultSnapshots.actionInvocationId),
                variantRevisions: transaction
                  .select()
                  .from(productVariantRevisions)
                  .where(eq(productVariantRevisions.tenantId, tenantId))
                  .orderBy(productVariantRevisions.variantId, productVariantRevisions.revision),
                variants: transaction
                  .select()
                  .from(productVariants)
                  .where(eq(productVariants.tenantId, tenantId))
                  .orderBy(productVariants.variantId),
              },
              { concurrency: 1 },
            ),
          )
          .pipe(Effect.provide(fixture.layer));
      const firstKey = yield* nextId;
      const first = yield* create({}, firstKey);
      expect(first.classification).toEqual({ kind: 'INDEPENDENT_PRODUCT' });
      expect(first.product).toMatchObject({ catalogReady: false, lifecycle: 'DRAFT' });
      expect(first.product.variants).toMatchObject([{ lifecycle: 'WORK_IN_PROGRESS' }]);
      const committed = yield* observe();
      expect(committed.products).toHaveLength(1);
      expect(committed.variants).toHaveLength(1);
      expect(committed.revisions).toMatchObject([
        { actingPrincipalId: fixture.manager.principalId, changeKind: 'CREATED', reason: null },
      ]);
      expect(committed.variantRevisions).toMatchObject([{ changeKind: 'CREATED', reason: null }]);
      expect(committed.snapshots).toHaveLength(1);
      const [snapshot] = committed.snapshots;
      assert(snapshot !== undefined);
      const evidence = yield* fixture.evidence(coreEvidenceExecutor);
      expect(
        evidence.audits.filter(
          (audit) => audit.actionInvocationId === snapshot.actionInvocationId && audit.outcome === 'succeeded',
        ),
      ).toMatchObject([{ evidenceJson: {}, principalId: fixture.manager.principalId, tenantId }]);
      const originalAudit = evidence.audits.find(
        (audit) => audit.actionInvocationId === snapshot.actionInvocationId && audit.outcome === 'succeeded',
      );
      assert(originalAudit !== undefined);
      expect(originalAudit.evidenceJson).not.toHaveProperty('reason');
      const repeated = yield* create({}, firstKey).pipe(Effect.flip);
      expect(Schema.is(CreateProductActionAlreadyCommittedProblemSchema)(repeated)).toBe(true);
      const changed = yield* create({ name: 'Changed intent' }, firstKey).pipe(Effect.flip);
      expect(Schema.is(CreateProductActionConflictProblemSchema)(changed)).toBe(true);
      expect((yield* observe()).products).toHaveLength(1);
      const read = Effect.fn('IndependentCreate.read')(function* read(
        path: string,
        payload: string,
        actor = fixture.manager,
      ) {
        const bearer = yield* authorization(actor);
        const correlationId = yield* nextId;
        return yield* Effect.tryPromise(() =>
          app.handler(
            new Request(`https://catalog.ontos.test${path}`, {
              body: payload,
              headers: { authorization: bearer, 'content-type': 'application/json', 'x-correlation-id': correlationId },
              method: 'POST',
            }),
            emptyContext,
          ),
        );
      });
      const nativeRecovery = yield* fixture
        .prepareOwner((transaction, scope) =>
          Effect.gen(function* nativeRecoveryControl() {
            const service = yield* catalogPersistenceForScope(transaction, scope);
            return yield* service.recoverCreateProduct(snapshot.actionInvocationId);
          }),
        )
        .pipe(Effect.provide(fixture.layer));
      expect(nativeRecovery.status).toBe('committed');
      const recovery = yield* read(
        '/reads/create-product-recovery',
        JSON.stringify({ invocationId: snapshot.actionInvocationId }),
      );
      expect(recovery.status).toBe(200);
      expect(
        yield* Schema.decodeUnknownEffect(CreateProductResultSchema)(yield* Effect.tryPromise(() => recovery.json())),
      ).toEqual(first);
      const historyResponse = yield* read(
        '/reads/product-history',
        JSON.stringify({ productRef: first.product.productRef }),
      );
      expect(historyResponse.status).toBe(200);
      const history = yield* Schema.decodeUnknownEffect(ProductHistoryResponseSchema)(
        yield* Effect.tryPromise(() => historyResponse.json()),
      );
      expect(history.history.revisions).toHaveLength(1);
      expect(history.history.revisions[0]).not.toHaveProperty('reason');
      const variantHistoryResponse = yield* read(
        '/reads/variant-history',
        JSON.stringify({ reference: { resourceRef: first.product.variants[0]?.variantRef, revision: 1 } }),
      );
      expect(variantHistoryResponse.status).toBe(200);
      const variantHistory = yield* Schema.decodeUnknownEffect(VariantHistoryResponseSchema)(
        yield* Effect.tryPromise(() => variantHistoryResponse.json()),
      );
      expect(variantHistory).not.toHaveProperty('reason');
      const realReason = 'Owner supplied new Product rationale';
      const explicit = yield* create({ classification: { kind: 'INDEPENDENT_PRODUCT' }, reason: realReason });
      const withReason = yield* observe();
      expect(withReason.revisions.find((row) => row.productId === explicit.product.productRef.resourceId)?.reason).toBe(
        realReason,
      );
      expect(withReason.variantRevisions.find((row) => row.variantId === explicit.variantId)?.reason).toBe(realReason);
      const explicitHistoryResponse = yield* read(
        '/reads/product-history',
        JSON.stringify({ productRef: explicit.product.productRef }),
      );
      expect(explicitHistoryResponse.status).toBe(200);
      const explicitHistory = yield* Schema.decodeUnknownEffect(ProductHistoryResponseSchema)(
        yield* Effect.tryPromise(() => explicitHistoryResponse.json()),
      );
      expect(explicitHistory.history.revisions[0]?.reason).toBe(realReason);
      const successorReason = 'A distinct good succeeds the predecessor';
      const successorInput = yield* Schema.decodeUnknownEffect(CreateProductPayloadSchema)({
        classification: {
          affectsOpenSelection: true as const,
          evidenceRefs: ['catalog:review'],
          kind: 'NEW_PRODUCT' as const,
          previousProductRef: first.product.productRef,
          reason: successorReason,
        },
        reason: successorReason,
      });
      const successor = yield* create(successorInput);
      expect(successor.product.productRef.resourceId).not.toBe(first.product.productRef.resourceId);
      expect(successor.classification).toMatchObject({
        kind: 'NEW_PRODUCT',
        previousProductRef: first.product.productRef,
      });
      const beforeRejected = yield* observe();
      const beforeMissingPredecessorEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      const missingPredecessorRef = { ...first.product.productRef, resourceId: yield* nextId };
      expect(beforeRejected.products.some((row) => row.productId === missingPredecessorRef.resourceId)).toBe(false);
      const missingPredecessor = yield* create({
        classification: {
          affectsOpenSelection: true,
          evidenceRefs: ['catalog:review'],
          kind: 'NEW_PRODUCT',
          previousProductRef: missingPredecessorRef,
          reason: successorReason,
        },
        reason: successorReason,
      }).pipe(Effect.flip);
      expect(Schema.is(CreateProductActionIneligibleProblemSchema)(missingPredecessor)).toBe(true);
      expect(missingPredecessor).toMatchObject({ code: 'product_correction_required', status: 422 });
      expect(yield* observe()).toEqual(beforeRejected);
      const afterMissingPredecessorEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      expect(afterMissingPredecessorEvidence.events).toEqual(beforeMissingPredecessorEvidence.events);
      expect(afterMissingPredecessorEvidence.outbox).toEqual(beforeMissingPredecessorEvidence.outbox);
      expect(afterMissingPredecessorEvidence.audits.filter((audit) => audit.outcome === 'succeeded')).toEqual(
        beforeMissingPredecessorEvidence.audits.filter((audit) => audit.outcome === 'succeeded'),
      );
      const mismatch = yield* create({ ...successorInput, reason: 'Different action reason' }).pipe(Effect.flip);
      expect(Schema.is(CreateProductActionIneligibleProblemSchema)(mismatch)).toBe(true);
      // v2: the one access gate decides this Action (O62); a principal from another Tenant with no
      // assignment is refused by the gate, named on the fixture's own per-request owner seam.
      deniedAccess.deny(ungranted.manager.principalId, 'commerce.catalog.product.create');
      const denied = yield* create({}, undefined, ungranted.manager).pipe(
        Effect.match({
          onFailure: Schema.is(CreateProductActionForbiddenProblemSchema),
          onSuccess: () => false,
        }),
      );
      expect(denied).toBe(true);
      expect((yield* ungranted.evidence(coreEvidenceExecutor)).audits).toMatchObject([
        { outcomeCode: 'spicedb_permission_denied' },
      ]);
      const deniedProducts = yield* ungranted
        .prepareOwner((transaction) =>
          transaction.select().from(products).where(eq(products.tenantId, ungranted.tenantId)),
        )
        .pipe(Effect.provide(ungranted.layer));
      expect(deniedProducts).toEqual([]);
      expect((yield* observe()).products).toHaveLength(beforeRejected.products.length);
      fixture.faultNextTransaction('rollback');
      const rollback = yield* create({ name: 'Must roll back completely' }).pipe(Effect.flip);
      expect(Schema.is(CreateProductActionUnavailableProblemSchema)(rollback)).toBe(true);
      expect(yield* observe()).toEqual(beforeRejected);
      const lostKey = yield* nextId;
      fixture.faultNextTransaction('lost-ack');
      const lost = yield* create({ name: 'Lost response' }, lostKey).pipe(Effect.flip);
      expect(Schema.is(CreateProductActionCommitIndeterminateProblemSchema)(lost)).toBe(true);
      expect(lost).toMatchObject({ resolution: 'RECOVER_CREATE_PRODUCT', retryCommand: false, status: 503 });
      const afterLost = yield* observe();
      expect(afterLost.products).toHaveLength(beforeRejected.products.length + 1);
      const lostSnapshot = afterLost.snapshots.find(
        (row) => !beforeRejected.snapshots.some((old) => old.actionInvocationId === row.actionInvocationId),
      );
      assert(lostSnapshot !== undefined);
      const recoveredLost = yield* read(
        '/reads/create-product-recovery',
        JSON.stringify({ invocationId: lostSnapshot.actionInvocationId }),
      );
      expect(recoveredLost.status).toBe(200);
      const lostResult = yield* Schema.decodeUnknownEffect(CreateProductResultSchema)(
        yield* Effect.tryPromise(() => recoveredLost.json()),
      );
      expect(lostResult.product.name).toBe('Lost response');
      expect(
        Schema.is(CreateProductActionAlreadyCommittedProblemSchema)(
          yield* create({ name: 'Lost response' }, lostKey).pipe(Effect.flip),
        ),
      ).toBe(true);
      const [productRevision] = committed.revisions;
      const [variantRevision] = committed.variantRevisions;
      assert(productRevision !== undefined && variantRevision !== undefined);
      for (const reason of [null, '', ' ', 'x'.repeat(1001)]) {
        const productInvocation = yield* nextId;
        const productRevisionId = yield* nextId;
        const variantInvocation = yield* nextId;
        const productFailure = yield* fixture
          .prepareOwner((transaction) =>
            transaction.insert(productRevisions).values({
              ...productRevision,
              actionInvocationId: productInvocation,
              changeKind: 'UPDATED',
              productRevisionId,
              reason,
              revision: 99,
            }),
          )
          .pipe(Effect.provide(fixture.layer), Effect.flip);
        expect(Option.getOrNull(findPostgresFailure(productFailure))).toEqual({
          code: '23514',
          constraint: 'catalog_product_revisions_reason_ck',
        });
        const variantFailure = yield* fixture
          .prepareOwner((transaction) =>
            transaction.insert(productVariantRevisions).values({
              ...variantRevision,
              actionInvocationId: variantInvocation,
              changeKind: 'CORRECTED',
              reason,
              revision: 99,
            }),
          )
          .pipe(Effect.provide(fixture.layer), Effect.flip);
        expect(Option.getOrNull(findPostgresFailure(variantFailure))).toEqual({
          code: '23514',
          constraint: 'catalog_product_variant_revisions_reason_ck',
        });
      }
      expect(yield* observe()).toEqual(afterLost);
      yield* Effect.gen(function* sourceCorrelationAcceptance() {
        const source = {
          issuerId: 'internal-fixture-ebs-a',
          mappingRevision: 'internal-v1',
          recordId: 'literal-source-a',
          recordNamespace: 'catalog-product',
          routeScope: 'internal-fixture-route',
        };
        const sourcePayload = {
          name: 'Exact source Product',
          sourceCorrelation: {
            ...source,
            initialVariantRecordId: 'literal-variant-b',
            sourceOccurrenceId: 'internal-primary-product-occurrence',
          },
        };
        const sourced = yield* create(sourcePayload);
        const sourceBeforeReplay = yield* observe();
        expect(yield* create(sourcePayload)).toEqual(sourced);
        expect((yield* observe()).products).toHaveLength(sourceBeforeReplay.products.length);
        expect((yield* observe()).variants).toHaveLength(sourceBeforeReplay.variants.length);
        yield* Effect.gen(function* distinctCoreInvocationRetainsBusinessSource() {
          const businessOriginal = sourced.businessOriginalCreateInvocationId;
          assert(businessOriginal !== undefined);
          const sourceIdentity = yield* createProductRequestIdentity(sourcePayload);
          const sourceHash = computeActionRequestHash({ ...sourceIdentity, principal: fixture.manager });
          const sourceInvocations = (yield* fixture.evidence(coreEvidenceExecutor)).invocations.filter(
            (row) => row.requestHash === sourceHash,
          );
          expect(sourceInvocations).toHaveLength(2);
          expect(new Set(sourceInvocations.map((row) => row.actionInvocationId)).size).toBe(2);
          const currentReplay = sourceInvocations.find((row) => row.actionInvocationId !== businessOriginal);
          assert(currentReplay !== undefined);
          const exactReplayRecovery = yield* read(
            '/reads/create-product-recovery',
            JSON.stringify({ invocationId: currentReplay.actionInvocationId }),
          );
          expect(exactReplayRecovery.status).toBe(200);
          const replayResult = yield* Schema.decodeUnknownEffect(CreateProductResultSchema)(
            yield* Effect.tryPromise(() => exactReplayRecovery.json()),
          );
          expect(replayResult.businessOriginalCreateInvocationId).toBe(businessOriginal);
          expect(replayResult.product.productRef).toEqual(sourced.product.productRef);
          expect(replayResult).toEqual(sourced);
        });

        const sourceConflict = yield* create({ ...sourcePayload, name: 'Conflicting new intent' }).pipe(Effect.flip);
        expect(Schema.is(CreateProductActionConflictProblemSchema)(sourceConflict)).toBe(true);
        const remapConflict = yield* create({
          ...sourcePayload,
          sourceCorrelation: { ...sourcePayload.sourceCorrelation, mappingRevision: 'internal-v2' },
        }).pipe(Effect.flip);
        expect(Schema.is(CreateProductActionConflictProblemSchema)(remapConflict)).toBe(true);
        const sourceRead = Effect.fn('IndependentCreate.sourceRead')(function* sourceRead(
          payload: CatalogSourceProductsRequest,
        ) {
          const wire = yield* Schema.encodeEffect(CatalogSourceProductsRequestSchema)(payload);
          const response = yield* read('/reads/catalog-source-products', JSON.stringify(wire));
          const body = yield* Effect.tryPromise(() => response.json());
          expect(response.status, JSON.stringify(body)).toBe(200);
          return yield* Schema.decodeUnknownEffect(CatalogSourceProductsResponseSchema)(body);
        });
        const lookup = yield* sourceRead({ ...source, entityKind: 'PRODUCT', operation: 'LOOKUP' });
        expect(lookup.items).toMatchObject([
          {
            product: { lifecycle: 'DRAFT', productRef: sourced.product.productRef },
            variantId: sourced.variantId,
            variantSources: [{ source: { recordId: 'literal-variant-b' }, variantId: sourced.variantId }],
          },
        ]);
        const variantLookup = yield* sourceRead({
          ...source,
          entityKind: 'VARIANT',
          operation: 'LOOKUP',
          recordId: 'literal-variant-b',
        });
        expect(variantLookup.items[0]?.variantId).toBe(sourced.variantId);
        deniedAccess.deny(fixture.manager.principalId, 'commerce.catalog.catalog-source-products.read');
        const deniedSourceRead = yield* read(
          '/reads/catalog-source-products',
          JSON.stringify(
            yield* Schema.encodeEffect(CatalogSourceProductsRequestSchema)({
              ...source,
              entityKind: 'PRODUCT',
              operation: 'LOOKUP',
            }),
          ),
        );
        expect(deniedSourceRead.status).toBe(403);
        deniedAccess.allow(fixture.manager.principalId, 'commerce.catalog.catalog-source-products.read');
        const additionalVariantRef = {
          moduleId: 'commerce.catalog',
          resourceId: yield* nextId,
          resourceType: 'commerce.catalog.variant',
          tenantId,
        } as const;
        const additionalVariantReason = 'Internal fixture proves a distinct recorded realization';
        const additionalVariantEvidence = ['internal-fixture:explicit-additional-realization'] as const;
        const variantPayload = yield* Schema.decodeUnknownEffect(CreateVariantPayloadSchema)({
          classification: {
            affectsOpenSelection: true,
            evidenceRefs: additionalVariantEvidence,
            kind: 'NEW_REALIZATION',
            newVariantRef: additionalVariantRef,
            productRef: sourced.product.productRef,
            reason: additionalVariantReason,
          },
          evidenceRefs: additionalVariantEvidence,
          expectedProductRevision: sourced.product.revision,
          productRef: sourced.product.productRef,
          reason: additionalVariantReason,
          sourceCorrelation: {
            ...source,
            recordId: 'literal-variant-a',
            sourceOccurrenceId: 'internal-primary-variant-occurrence',
          },
          variantRef: additionalVariantRef,
        });
        const createAdditionalVariant = Effect.fn('IndependentCreate.createAdditionalVariant')(
          function* createAdditionalVariant() {
            return yield* requireExecutionResult(
              CreateVariantResultSchema,
              executeCreateVariantWithAuthorization(variantPayload, yield* authorization(), yield* nextId, {
                baseUrl: 'https://catalog.ontos.test',
                compositionRevision: composition.composition.revision,
                idempotencyKey: yield* nextId,
              }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch)),
            );
          },
        );
        const additionalVariant = yield* createAdditionalVariant();
        expect(yield* createAdditionalVariant()).toEqual(additionalVariant);
        yield* Effect.gen(function* distinctVariantCoreInvocationRetainsBusinessSource() {
          const businessOriginal = additionalVariant.businessOriginalCreateInvocationId;
          assert(businessOriginal !== undefined);
          const variantIdentity = yield* createVariantRequestIdentity(variantPayload);
          const variantHash = computeActionRequestHash({ ...variantIdentity, principal: fixture.manager });
          const variantInvocations = (yield* fixture.evidence(coreEvidenceExecutor)).invocations.filter(
            (row) => row.requestHash === variantHash,
          );
          expect(variantInvocations).toHaveLength(2);
          const currentReplay = variantInvocations.find((row) => row.actionInvocationId !== businessOriginal);
          assert(currentReplay !== undefined);
          const exactReplayRecovery = yield* read(
            '/reads/create-variant-recovery',
            JSON.stringify({ invocationId: currentReplay.actionInvocationId }),
          );
          expect(exactReplayRecovery.status).toBe(200);
          const replayResult = yield* Schema.decodeUnknownEffect(CreateVariantResultSchema)(
            yield* Effect.tryPromise(() => exactReplayRecovery.json()),
          );
          expect(replayResult.businessOriginalCreateInvocationId).toBe(businessOriginal);
          expect(replayResult).toEqual(additionalVariant);
          const nativeVariants = (yield* observe()).variants.filter(
            (row) => row.variantId === additionalVariantRef.resourceId,
          );
          expect(nativeVariants).toHaveLength(1);
        });

        const reorderedSources = yield* sourceRead({ ...source, entityKind: 'PRODUCT', operation: 'LOOKUP' });
        expect(reorderedSources.items[0]?.variantSources.map((item) => item.source.recordId)).toEqual([
          'literal-variant-a',
          'literal-variant-b',
        ]);
        expect(reorderedSources.items[0]?.variantId).toBe(sourced.variantId);
        expect(reorderedSources.items[0]?.variantSources[0]?.variantId).toBe(additionalVariantRef.resourceId);
        const initialAfterNewVariant = yield* sourceRead({
          ...source,
          entityKind: 'VARIANT',
          operation: 'LOOKUP',
          recordId: 'literal-variant-b',
        });
        expect(initialAfterNewVariant.items[0]?.variantId).toBe(sourced.variantId);

        const otherIssuer = yield* create({
          ...sourcePayload,
          sourceCorrelation: { ...sourcePayload.sourceCorrelation, issuerId: 'internal-fixture-ebs-b' },
        });
        expect(otherIssuer.product.productRef).not.toEqual(sourced.product.productRef);
        const missingRoute = yield* sourceRead({
          ...source,
          entityKind: 'PRODUCT',
          operation: 'LOOKUP',
          routeScope: 'different-route',
        });
        expect(missingRoute).toEqual({ items: [], outcome: 'NOT_FOUND' });
        const unresolvedSource = {
          ...source,
          recordId: 'literal-source-z',
          sourceOccurrenceId: 'internal-unresolved-product-occurrence',
        };
        const unresolved = yield* create({ sourceCorrelation: unresolvedSource });
        const unresolvedRead = yield* sourceRead({ ...unresolvedSource, entityKind: 'PRODUCT', operation: 'LOOKUP' });
        expect(unresolvedRead.items[0]?.variantSources).toEqual([]);
        const originalCreateInvocationId = unresolvedRead.items[0]?.originalActionInvocationId;
        assert(originalCreateInvocationId !== undefined);
        const bind = Effect.fn('IndependentCreate.bindInitialVariant')(function* bindInitialVariant(
          sourceOccurrenceId: string,
          idempotencyKey: string,
        ) {
          return yield* executeBindInitialVariantSourceWithAuthorization(
            {
              evidenceRef: 'internal-fixture:explicit-first-variant-source-proof',
              expectedCreateInvocationId: originalCreateInvocationId,
              initialVariantRecordId: 'later-explicit-key',
              productSource: { ...unresolvedSource, sourceOccurrenceId },
            },
            yield* authorization(),
            yield* nextId,
            {
              baseUrl: 'https://catalog.ontos.test',
              compositionRevision: composition.composition.revision,
              idempotencyKey,
            },
          ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
        });
        const recoverBinding = Effect.fn('IndependentCreate.recoverInitialVariant')(function* recoverInitialVariant(
          invocationId: string,
        ) {
          const response = yield* read('/reads/bind-initial-variant-source-recovery', JSON.stringify({ invocationId }));
          expect(response.status).toBe(200);
          return yield* Schema.decodeUnknownEffect(BindInitialVariantSourceResultSchema)(
            yield* Effect.tryPromise(() => response.json()),
          );
        });
        const bindingKey = yield* nextId;
        fixture.faultNextTransaction('lost-ack');
        const lostBinding = yield* bind(unresolvedSource.sourceOccurrenceId, bindingKey).pipe(Effect.flip);
        assert(Schema.is(BindInitialVariantSourceActionCommitIndeterminateProblemSchema)(lostBinding));
        const bound = yield* recoverBinding(lostBinding.invocationId);
        expect(bound).toEqual({
          changed: true,
          originalCreateInvocationId,
          productId: unresolved.product.productRef.resourceId,
          variantId: unresolved.variantId,
        });
        const repeatedBinding = yield* bind(unresolvedSource.sourceOccurrenceId, bindingKey).pipe(Effect.flip);
        expect(Schema.is(BindInitialVariantSourceActionAlreadyCommittedProblemSchema)(repeatedBinding)).toBe(true);
        expect(repeatedBinding).toMatchObject({ invocationId: lostBinding.invocationId });

        const reused = yield* requireExecutionResult(
          BindInitialVariantSourceResultSchema,
          bind('internal-variant-binding-reuse', yield* nextId),
        );
        expect(reused).toEqual({ ...bound, changed: false });
        const reuseKey = yield* nextId;
        fixture.faultNextTransaction('lost-ack');
        const lostReuse = yield* bind('internal-variant-binding-lost-reuse', reuseKey).pipe(Effect.flip);
        assert(Schema.is(BindInitialVariantSourceActionCommitIndeterminateProblemSchema)(lostReuse));
        expect(lostReuse.invocationId).not.toBe(lostBinding.invocationId);
        expect(yield* recoverBinding(lostReuse.invocationId)).toEqual(reused);
        expect(yield* recoverBinding(lostBinding.invocationId)).toEqual(bound);
        const legacyResult = {
          originalCreateInvocationId,
          productId: unresolved.product.productRef.resourceId,
          variantId: unresolved.variantId,
        };
        expect(yield* Schema.decodeUnknownEffect(BindInitialVariantSourceResultSchema)(legacyResult)).toEqual(
          legacyResult,
        );
        const laterLookup = yield* sourceRead({
          ...source,
          entityKind: 'VARIANT',
          operation: 'LOOKUP',
          recordId: 'later-explicit-key',
        });
        expect(laterLookup.items[0]?.variantId).toBe(unresolved.variantId);
        const page1 = yield* sourceRead({ ...source, limit: 1, operation: 'LIST' });
        expect(page1.items[0]?.source.recordId).toBe('literal-source-a');
        expect(page1.nextRecordId).toBe('literal-source-a');
        const page2 = yield* sourceRead({ ...source, afterRecordId: page1.nextRecordId, limit: 1, operation: 'LIST' });
        expect(page2.items[0]?.source.recordId).toBe('literal-source-z');
        expect(page2.nextRecordId).toBeUndefined();
        const lostSource = { ...source, recordId: 'lost-source' };
        fixture.faultNextTransaction('lost-ack');
        const lostSourceFailure = yield* create({ sourceCorrelation: lostSource }).pipe(Effect.flip);
        expect(Schema.is(CreateProductActionCommitIndeterminateProblemSchema)(lostSourceFailure)).toBe(true);
        const lostSourceLookup = yield* sourceRead({ ...lostSource, entityKind: 'PRODUCT', operation: 'LOOKUP' });
        const sourceRecovered = yield* create({ sourceCorrelation: lostSource });
        expect(sourceRecovered.product.productRef).toEqual(lostSourceLookup.items[0]?.product.productRef);
        expect(sourceRecovered.variantId).toEqual(lostSourceLookup.items[0]?.variantId);
        const crossTenantResponse = yield* read(
          '/reads/catalog-source-products',
          JSON.stringify(
            yield* Schema.encodeEffect(CatalogSourceProductsRequestSchema)({
              ...source,
              entityKind: 'PRODUCT',
              operation: 'LOOKUP',
            }),
          ),
          ungranted.manager,
        );
        expect(crossTenantResponse.status).toBe(200);
        expect(
          yield* Schema.decodeUnknownEffect(CatalogSourceProductsResponseSchema)(
            yield* Effect.tryPromise(() => crossTenantResponse.json()),
          ),
        ).toEqual({ items: [], outcome: 'NOT_FOUND' });
        const beforeRace = yield* observe();
        const raceSource = { ...source, initialVariantRecordId: 'race-initial', recordId: 'race-source' };
        const racePayload = { name: 'One racing Product', sourceCorrelation: raceSource };
        const race = yield* Effect.all(
          [create(racePayload).pipe(Effect.result), create(racePayload).pipe(Effect.result)],
          { concurrency: 2 },
        );
        expect(race.some(Result.isSuccess)).toBe(true);
        for (const outcome of race) {
          if (Result.isFailure(outcome)) {
            expect(Schema.is(CreateProductActionConflictProblemSchema)(outcome.failure)).toBe(true);
          }
        }
        const raceRecovered = yield* create(racePayload);
        const afterRace = yield* observe();
        expect(afterRace.products).toHaveLength(beforeRace.products.length + 1);
        expect(afterRace.variants).toHaveLength(beforeRace.variants.length + 1);
        const raceReceipts = yield* fixture
          .prepareOwner((transaction) =>
            transaction
              .select()
              .from(catalogSourceCorrelations)
              .where(
                and(
                  eq(catalogSourceCorrelations.tenantId, tenantId),
                  eq(catalogSourceCorrelations.productId, raceRecovered.product.productRef.resourceId),
                ),
              ),
          )
          .pipe(Effect.provide(fixture.layer));
        expect(raceReceipts).toHaveLength(2);
        expect(
          EffectArray.sort(
            raceReceipts.map((row) => row.recordId),
            Order.String,
          ),
        ).toEqual(['race-initial', 'race-source']);
        expect(raceReceipts.every((row) => row.variantId === raceRecovered.variantId)).toBe(true);
        const beforeSecondBinding = yield* fixture
          .prepareOwner((transaction) =>
            transaction
              .select()
              .from(catalogSourceCorrelations)
              .where(
                and(
                  eq(catalogSourceCorrelations.tenantId, tenantId),
                  eq(catalogSourceCorrelations.productId, unresolved.product.productRef.resourceId),
                ),
              ),
          )
          .pipe(Effect.provide(fixture.layer));
        const secondBinding = yield* executeBindInitialVariantSourceWithAuthorization(
          {
            evidenceRef: 'internal-fixture:conflicting-initial-key',
            expectedCreateInvocationId: originalCreateInvocationId,
            initialVariantRecordId: 'second-initial-key',
            productSource: unresolvedSource,
          },
          yield* authorization(),
          yield* nextId,
          {
            baseUrl: 'https://catalog.ontos.test',
            compositionRevision: composition.composition.revision,
            idempotencyKey: yield* nextId,
          },
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch), Effect.result);
        expect(Result.isFailure(secondBinding)).toBe(true);
        if (Result.isFailure(secondBinding)) {
          expect(Schema.is(BindInitialVariantSourceActionConflictProblemSchema)(secondBinding.failure)).toBe(true);
        }
        const afterSecondBinding = yield* fixture
          .prepareOwner((transaction) =>
            transaction
              .select()
              .from(catalogSourceCorrelations)
              .where(
                and(
                  eq(catalogSourceCorrelations.tenantId, tenantId),
                  eq(catalogSourceCorrelations.productId, unresolved.product.productRef.resourceId),
                ),
              ),
          )
          .pipe(Effect.provide(fixture.layer));
        expect(afterSecondBinding).toEqual(beforeSecondBinding);
        const bindingSnapshot = (yield* observe()).snapshots.find(
          (row) => row.actionInvocationId === lostBinding.invocationId,
        );
        assert(bindingSnapshot !== undefined);
        const dataAccessEvidence = (yield* fixture.evidence(coreEvidenceExecutor)).accesses.filter(
          (row) => row.actionInvocationId === bindingSnapshot.actionInvocationId,
        );
        expect(
          dataAccessEvidence.some(
            (row) =>
              row.targetResourceId === unresolved.variantId && row.targetResourceType === 'commerce.catalog.variant',
          ),
        ).toBe(true);
        yield* Effect.gen(function* newOccurrencesPreserveBusinessCreate() {
          const before = yield* observe();
          const occurrenceSource = {
            ...source,
            initialVariantRecordId: 'occurrence-initial-variant',
            recordId: 'occurrence-product',
          };
          const payloadA = {
            name: 'Occurrence evidence Product',
            sourceCorrelation: { ...occurrenceSource, sourceOccurrenceId: 'internal-occurrence-product-a' },
          };
          const payloadB = {
            ...payloadA,
            sourceCorrelation: { ...payloadA.sourceCorrelation, sourceOccurrenceId: 'internal-occurrence-product-b' },
          };
          const createdA = yield* create(payloadA);
          expect(yield* create(payloadB)).toEqual(createdA);
          const identityA = yield* createProductRequestIdentity(payloadA);
          const identityB = yield* createProductRequestIdentity(payloadB);
          const hashA = computeActionRequestHash({ ...identityA, principal: fixture.manager });
          const hashB = computeActionRequestHash({ ...identityB, principal: fixture.manager });
          expect(hashB).not.toBe(hashA);
          const occurrenceEvidence = yield* fixture.evidence(coreEvidenceExecutor);
          const invocations = occurrenceEvidence.invocations.filter(
            (row) => row.requestHash === hashA || row.requestHash === hashB,
          );
          expect(invocations).toHaveLength(2);
          const currentB = invocations.find((row) => row.requestHash === hashB);
          assert(currentB !== undefined);
          expect(currentB.actionInvocationId).not.toBe(createdA.businessOriginalCreateInvocationId);
          const recoveryResponse = yield* read(
            '/reads/create-product-recovery',
            JSON.stringify({ invocationId: currentB.actionInvocationId }),
          );
          expect(recoveryResponse.status).toBe(200);
          expect(
            yield* Schema.decodeUnknownEffect(CreateProductResultSchema)(
              yield* Effect.tryPromise(() => recoveryResponse.json()),
            ),
          ).toEqual(createdA);
          const afterProduct = yield* observe();
          expect(afterProduct.products).toHaveLength(before.products.length + 1);
          expect(afterProduct.variants).toHaveLength(before.variants.length + 1);
          const occurrenceVariantRef = {
            moduleId: 'commerce.catalog',
            resourceId: yield* nextId,
            resourceType: 'commerce.catalog.variant',
            tenantId,
          } as const;
          const variantReason = 'Internal evidence names a distinct occurrence realization';
          const variantEvidence = ['internal-fixture:occurrence-realization-proof'] as const;
          const variantA = yield* Schema.decodeUnknownEffect(CreateVariantPayloadSchema)({
            classification: {
              affectsOpenSelection: true,
              evidenceRefs: variantEvidence,
              kind: 'NEW_REALIZATION',
              newVariantRef: occurrenceVariantRef,
              productRef: createdA.product.productRef,
              reason: variantReason,
            },
            evidenceRefs: variantEvidence,
            expectedProductRevision: createdA.product.revision,
            productRef: createdA.product.productRef,
            reason: variantReason,
            sourceCorrelation: {
              ...source,
              recordId: 'occurrence-extra-variant',
              sourceOccurrenceId: 'internal-occurrence-variant-a',
            },
            variantRef: occurrenceVariantRef,
          });
          const sourceOfVariantA = variantA.sourceCorrelation;
          assert(sourceOfVariantA !== undefined);
          const variantB = {
            ...variantA,
            sourceCorrelation: { ...sourceOfVariantA, sourceOccurrenceId: 'internal-occurrence-variant-b' },
          };
          const createOccurrenceVariant = Effect.fn('NativeOccurrence.createVariant')(function* createOccurrenceVariant(
            payload: typeof CreateVariantPayloadSchema.Type,
          ) {
            return yield* requireExecutionResult(
              CreateVariantResultSchema,
              executeCreateVariantWithAuthorization(payload, yield* authorization(), yield* nextId, {
                baseUrl: 'https://catalog.ontos.test',
                compositionRevision: composition.composition.revision,
                idempotencyKey: yield* nextId,
              }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch)),
            );
          });
          const createdVariantA = yield* createOccurrenceVariant(variantA);
          expect(yield* createOccurrenceVariant(variantB)).toEqual(createdVariantA);
          const variantHashA = computeActionRequestHash({
            ...(yield* createVariantRequestIdentity(variantA)),
            principal: fixture.manager,
          });
          const variantHashB = computeActionRequestHash({
            ...(yield* createVariantRequestIdentity(variantB)),
            principal: fixture.manager,
          });
          expect(variantHashB).not.toBe(variantHashA);
          const variantInvocations = (yield* fixture.evidence(coreEvidenceExecutor)).invocations.filter(
            (row) => row.requestHash === variantHashA || row.requestHash === variantHashB,
          );
          expect(variantInvocations).toHaveLength(2);
          const variantCurrentB = variantInvocations.find((row) => row.requestHash === variantHashB);
          assert(variantCurrentB !== undefined);
          expect(variantCurrentB.actionInvocationId).not.toBe(createdVariantA.businessOriginalCreateInvocationId);
          const variantRecoveryResponse = yield* read(
            '/reads/create-variant-recovery',
            JSON.stringify({ invocationId: variantCurrentB.actionInvocationId }),
          );
          expect(variantRecoveryResponse.status).toBe(200);
          expect(
            yield* Schema.decodeUnknownEffect(CreateVariantResultSchema)(
              yield* Effect.tryPromise(() => variantRecoveryResponse.json()),
            ),
          ).toEqual(createdVariantA);
          expect((yield* observe()).variants).toHaveLength(before.variants.length + 2);
          const changedBusiness = yield* create({
            ...payloadB,
            name: 'Different business facts cannot be occurrence replay',
          }).pipe(Effect.result);
          expect(Result.isFailure(changedBusiness)).toBe(true);
          if (Result.isFailure(changedBusiness)) {
            expect(Schema.is(CreateProductActionConflictProblemSchema)(changedBusiness.failure)).toBe(true);
          }
        });
        yield* Effect.gen(function* nativeRequestIdentityParity() {
          const parityProduct = yield* create({ name: 'Internal request identity subject' });
          const updateKey = yield* nextId;
          const updatePayload = yield* Schema.decodeUnknownEffect(UpdateProductPayloadSchema)({
            expectedRevision: parityProduct.product.revision,
            productRef: parityProduct.product.productRef,
            reason: 'Internal fixture records the supported no-op update intent',
          });
          const updated = yield* requireExecutionResult(
            UpdateProductResultSchema,
            executeUpdateProductWithAuthorization(updatePayload, yield* authorization(), yield* nextId, {
              baseUrl: 'https://catalog.ontos.test',
              compositionRevision: composition.composition.revision,
              idempotencyKey: updateKey,
            }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch)),
          );
          const correctionKey = yield* nextId;
          const correctionReason = 'Internal fixture corrects the evidenced Product name';
          const correctionPayload = yield* Schema.decodeUnknownEffect(CorrectProductPayloadSchema)({
            classification: {
              affectsOpenSelection: false,
              evidenceRefs: ['internal-fixture:name-correction-proof'],
              kind: 'COSMETIC_CORRECTION',
              productRef: parityProduct.product.productRef,
              reason: correctionReason,
            },
            expectedRevision: updated.product.revision,
            name: 'Corrected internal request identity subject',
            productRef: parityProduct.product.productRef,
            reason: correctionReason,
          });
          yield* requireExecutionResult(
            CorrectProductResultSchema,
            executeCorrectProductWithAuthorization(correctionPayload, yield* authorization(), yield* nextId, {
              baseUrl: 'https://catalog.ontos.test',
              compositionRevision: composition.composition.revision,
              idempotencyKey: correctionKey,
            }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch)),
          );
          const evidenceForIdentity = yield* fixture.evidence(coreEvidenceExecutor);
          const variantSnapshot = (yield* observe()).snapshots.find(
            (row) => row.actionInvocationId === additionalVariant.businessOriginalCreateInvocationId,
          );
          const sourceCreateInvocation = lookup.items[0]?.originalActionInvocationId;
          assert(sourceCreateInvocation !== undefined && variantSnapshot !== undefined);
          const updateInvocation = evidenceForIdentity.invocations.find((row) => row.idempotencyKey === updateKey);
          const correctionInvocation = evidenceForIdentity.invocations.find(
            (row) => row.idempotencyKey === correctionKey,
          );
          assert(updateInvocation !== undefined && correctionInvocation !== undefined);
          const identities = [
            {
              identity: yield* createProductRequestIdentity({ ...sourcePayload, name: '  Exact source Product  ' }),
              invocationId: sourceCreateInvocation,
            },
            {
              identity: yield* createVariantRequestIdentity(variantPayload),
              invocationId: variantSnapshot.actionInvocationId,
            },
            {
              identity: yield* updateProductRequestIdentity(updatePayload),
              invocationId: updateInvocation.actionInvocationId,
            },
            {
              identity: yield* correctProductRequestIdentity(correctionPayload),
              invocationId: correctionInvocation.actionInvocationId,
            },
            {
              identity: yield* bindInitialVariantSourceRequestIdentity({
                evidenceRef: 'internal-fixture:explicit-first-variant-source-proof',
                expectedCreateInvocationId: originalCreateInvocationId,
                initialVariantRecordId: 'later-explicit-key',
                productSource: unresolvedSource,
              }),
              invocationId: bindingSnapshot.actionInvocationId,
            },
          ];
          for (const { identity, invocationId } of identities) {
            const invocation = evidenceForIdentity.invocations.find((row) => row.actionInvocationId === invocationId);
            assert(invocation !== undefined);
            expect(identity.target).toEqual({});
            expect(computeActionRequestHash({ ...identity, principal: fixture.manager }), identity.actionKey).toBe(
              invocation.requestHash,
            );
            expect(
              computeActionRequestHash({
                ...identity,
                principal: fixture.manager,
                target: {
                  targetModuleKey: 'commerce.catalog',
                  targetResourceId: parityProduct.product.productRef.resourceId,
                  targetResourceType: 'commerce.catalog.product',
                },
              }),
            ).not.toBe(invocation.requestHash);
          }
        });
      });
    }).pipe(Effect.provide(nativeServices)),
  120_000,
);
