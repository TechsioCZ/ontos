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
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { eq } from 'drizzle-orm';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
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
import { createProductAction } from '../../src/actions/create-product.action.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import { executeCreateProductWithAuthorization } from '../../src/api/create-product-action-client.ts';
import {
  catalogResultSnapshots,
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
      yield* isolated.assertClonedSchema();
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
          actionKeys: [createProductAction.descriptor.actionKey],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          allowedAudiences: ['catalog'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.composition.revision,
          moduleKeys: ['commerce.catalog'],
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
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      const { tenantId } = fixture;
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      const principal = { principalId: fixture.manager.principalId, tenantId };
      const targets = [
        { moduleId: 'commerce.catalog', permission: 'module.access' as const },
        { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.create-product-recovery' as const },
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
        .add(catalogApi.groups.productHistory)
        .add(catalogApi.groups.variantHistory);
      const handlers = Layer.mergeAll(
        createProductActionApiLive,
        createProductRecoveryReadApiLive,
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
        Layer.provide(fixture.layer),
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
              Layer.provideMerge(fixture.layer),
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
        return yield* executeCreateProductWithAuthorization(payload, yield* authorization(actor), yield* nextId, {
          baseUrl: 'https://catalog.ontos.test',
          compositionRevision: composition.composition.revision,
          idempotencyKey: key ?? (yield* nextId),
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
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
      const read = Effect.fn('IndependentCreate.read')(function* read(path: string, payload: string) {
        const bearer = yield* authorization();
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
    }).pipe(Effect.provide(nativeServices)),
  120_000,
);
