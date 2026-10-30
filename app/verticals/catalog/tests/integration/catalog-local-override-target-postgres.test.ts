import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
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
import { and, eq, sql } from 'drizzle-orm';
import { ConfigProvider, Context, Crypto, DateTime, Deferred, Effect, Fiber, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { createProductActionApiLive } from '../../api/create-product-action-server.ts';
import { activateLocalOverrideActionApiLive } from '../../api/activate-local-override-action-server.ts';
import { changeLocalOverrideActionApiLive } from '../../api/change-local-override-action-server.ts';
import { releaseLocalOverrideActionApiLive } from '../../api/release-local-override-action-server.ts';
import { activateLocalOverrideRecoveryReadApiLive } from '../../api/activate-local-override-recovery-read-server.ts';
import { catalogSourceResolutionReadApiLive } from '../../api/catalog-source-resolution-read-server.ts';
import type { CreateProductPayloadSchema } from '../../shared/actions/create-product.ts';
import {
  ActivateLocalOverrideActionAlreadyCommittedProblemSchema,
  ActivateLocalOverrideActionForbiddenProblemSchema,
  ActivateLocalOverrideActionIneligibleProblemSchema,
  ActivateLocalOverrideActionUnavailableProblemSchema,
} from '../../shared/apis/activate-local-override-action.ts';
import {
  CatalogSourceResolutionForbiddenProblemSchema,
  CatalogSourceResolutionNotFoundProblemSchema,
} from '../../shared/apis/catalog-source-resolution.ts';
import {
  ActivateLocalOverridePayloadSchema,
  ChangeLocalOverridePayloadSchema,
  ReleaseLocalOverridePayloadSchema,
  CatalogLocalOverrideResultSchema,
} from '../../shared/actions/catalog-source-resolution.ts';
import { executeActivateLocalOverrideWithAuthorization } from '../../src/api/activate-local-override-action-client.ts';
import { executeChangeLocalOverrideWithAuthorization } from '../../src/api/change-local-override-action-client.ts';
import { executeReleaseLocalOverrideWithAuthorization } from '../../src/api/release-local-override-action-client.ts';
import { executeCatalogSourceResolutionWithAuthorization } from '../../src/api/catalog-source-resolution-client.ts';
import { activateLocalOverrideAction } from '../../src/actions/activate-local-override.action.ts';
import { changeLocalOverrideAction } from '../../src/actions/change-local-override.action.ts';
import { releaseLocalOverrideAction } from '../../src/actions/release-local-override.action.ts';
import { catalogSourceActionPersistenceFactoryLive } from '../../src/persistence/catalog-source-action-persistence.ts';
import { catalogImportAcceptanceServiceFactoryLive } from '../../src/persistence/catalog-import-acceptance-service.ts';
import { catalogLocalOverrideServiceFactoryLive } from '../../src/persistence/catalog-local-override-service.ts';
import { catalogProductExistsForScope } from '../../src/persistence/catalog-source-resolution-read-store.ts';
import { CatalogSourceResolutionUnavailable } from '../../src/persistence/catalog-source-resolution-ports.ts';
import { catalogExternalCorrelationResolverLive } from '../../src/persistence/external-correlation-resolver.ts';
import { catalogApi } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createProductAction } from '../../src/actions/create-product.action.ts';
import { executeCreateProductWithAuthorization } from '../../src/api/create-product-action-client.ts';
import {
  catalogResultSnapshots,
  catalogLocalOverrideHeads,
  catalogLocalOverrideRevisions,
  products,
} from '../../src/database/schema.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());
type NativeFixture = Effect.Success<ReturnType<typeof makeLiveOperationFixture>>;

const holdProductIdentityLock = Effect.fn('OverrideTarget.holdProductIdentityLock')(function* holdProductIdentityLock(
  fixture: NativeFixture,
  productId: string,
  locked: Deferred.Deferred<number>,
  release: Deferred.Deferred<null>,
) {
  return yield* fixture
    .prepareOwner((transaction, scope) =>
      Effect.gen(function* holdProduct() {
        yield* transaction
          .select({ productId: products.productId })
          .from(products)
          .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, productId)))
          .for('update');
        // Test infrastructure metadata only: identify this owned clone's blocker connection without exposing query text.
        const [backend] = yield* transaction
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(products)
          .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, productId)));
        assert(backend !== undefined);
        yield* Deferred.succeed(locked, backend.pid);
        yield* Deferred.await(release);
      }),
    )
    .pipe(Effect.provide(fixture.layer));
});

const observesProductLockWait = Effect.fn('OverrideTarget.observesProductLockWait')(function* observesProductLockWait(
  fixture: NativeFixture,
  blockerPid: number,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    // Only this disposable database's wait graph is inspected, never SQL text or foreign business rows.
    const [row] = yield* fixture
      .prepareOwner((transaction) =>
        transaction
          .select({
            waiting: sql<boolean>`exists(select 1 from pg_stat_activity as activity
        where activity.datname = current_database()
          and ${blockerPid} = any(pg_blocking_pids(activity.pid)))`,
          })
          .from(products)
          .where(eq(products.tenantId, fixture.tenantId))
          .limit(1),
      )
      .pipe(Effect.provide(fixture.layer));
    if (row?.waiting) {
      return true;
    }
    yield* Effect.sleep('25 millis');
  }
  return false;
});

const lookupWithLocalLockTimeout = Effect.fn('OverrideTarget.lookupWithLocalLockTimeout')(
  function* lookupWithLocalLockTimeout(fixture: NativeFixture, productId: string) {
    return yield* fixture
      .prepareOwner((transaction, scope) =>
        Effect.gen(function* timedIdentityLookup() {
          // Test-only transaction-local fault: a real Product row-lock wait raises the real query error and rolls back.
          yield* transaction
            .select({ timeout: sql<string>`set_config('lock_timeout', '75ms', true)` })
            .from(products)
            .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, productId)));
          return yield* catalogProductExistsForScope(
            transaction,
            scope,
            true,
          )({ factKey: 'catalog.name', targetId: productId, targetKind: 'PRODUCT', tenantId: scope.tenantId });
        }),
      )
      .pipe(Effect.provide(fixture.layer));
  },
);

it.live(
  'requires actual Product identity for public Local Override and Current while preserving release, recovery and CAS',
  () =>
    Effect.gen(function* overrideTargetPostgres() {
      const composition = yield* makeApplicationCompositionSnapshotFixture(
        ['catalog'],
        ultramodernApiMarker.buildMarker,
      );
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        compositionSnapshot: composition,
        mode: 'schema-only',
        purpose: 'stabilization-1269-override-target-existence',
      });
      yield* isolated.assertClonedSchema();
      expect(isolated.connections.runtime.database).toBe(isolated.connections.admin.database);
      expect(isolated.connections.runtime.user).not.toBe(isolated.connections.admin.user);
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
          actionExecutor: 'manager-only',
          actionKeys: [
            createProductAction.descriptor.actionKey,
            activateLocalOverrideAction.descriptor.actionKey,
            changeLocalOverrideAction.descriptor.actionKey,
            releaseLocalOverrideAction.descriptor.actionKey,
          ],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          allowedAudiences: ['catalog'],
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.composition.revision,
          moduleKeys: ['commerce.catalog'],
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      // The public live fixture grants execution only to its fixed manager Principal.
      // A second genuine Tenant has CreateProduct only; it has no Local Override executor and proves foreign identity.
      const ungranted = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionExecutor: 'manager-only',
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
      const { tenantId } = fixture;
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      const principal = { principalId: fixture.manager.principalId, tenantId };
      const targets = [
        { moduleId: 'commerce.catalog', permission: 'module.access' as const },
        { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.activate-local-override-recovery' as const },
        { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.catalog-source-resolution' as const },
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
        const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
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
        .add(catalogApi.groups.activateLocalOverrideAction)
        .add(catalogApi.groups.changeLocalOverrideAction)
        .add(catalogApi.groups.releaseLocalOverrideAction)
        .add(catalogApi.groups.activateLocalOverrideRecovery)
        .add(catalogApi.groups.catalogSourceResolution);
      const handlers = Layer.mergeAll(
        createProductActionApiLive,
        activateLocalOverrideActionApiLive,
        changeLocalOverrideActionApiLive,
        releaseLocalOverrideActionApiLive,
        activateLocalOverrideRecoveryReadApiLive,
        catalogSourceResolutionReadApiLive,
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
          catalogSourceActionPersistenceFactoryLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                catalogImportAcceptanceServiceFactoryLive,
                catalogLocalOverrideServiceFactoryLive,
                catalogExternalCorrelationResolverLive,
              ),
            ),
          ),
        ),
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
                heads: transaction
                  .select()
                  .from(catalogLocalOverrideHeads)
                  .where(eq(catalogLocalOverrideHeads.tenantId, tenantId)),
                products: transaction.select().from(products).where(eq(products.tenantId, tenantId)),
                revisions: transaction
                  .select()
                  .from(catalogLocalOverrideRevisions)
                  .where(eq(catalogLocalOverrideRevisions.tenantId, tenantId)),
                snapshots: transaction
                  .select()
                  .from(catalogResultSnapshots)
                  .where(eq(catalogResultSnapshots.tenantId, tenantId)),
              },
              { concurrency: 1 },
            ),
          )
          .pipe(Effect.provide(fixture.layer));
      const activate = Effect.fn('OverrideTarget.activate')(function* activate(
        payload: typeof ActivateLocalOverridePayloadSchema.Type,
        key?: string,
        actor = fixture.manager,
      ) {
        return yield* executeActivateLocalOverrideWithAuthorization(
          payload,
          yield* authorization(actor),
          yield* nextId,
          {
            baseUrl: 'https://catalog.ontos.test',
            compositionRevision: composition.composition.revision,
            idempotencyKey: key ?? (yield* nextId),
          },
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      });
      const current = Effect.fn('OverrideTarget.current')(function* current(
        scope: (typeof ActivateLocalOverridePayloadSchema.Type)['scope'],
      ) {
        return yield* executeCatalogSourceResolutionWithAuthorization(
          { scope },
          yield* authorization(),
          yield* nextId,
          {
            baseUrl: 'https://catalog.ontos.test',
            compositionRevision: composition.composition.revision,
          },
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      });
      const missingId = yield* nextId;
      const absentPayload = yield* Schema.decodeUnknownEffect(ActivateLocalOverridePayloadSchema)({
        evidenceRef: 'catalog:1269:missing',
        reason: 'Exact existing Product only',
        scope: { factKey: 'catalog.name', targetId: missingId, targetKind: 'PRODUCT', tenantId },
        value: 'No phantom',
      });
      const missingKey = yield* nextId;
      expect((yield* activate(absentPayload, missingKey)).status).toBe('INVALID');
      const absentRows = yield* observe();
      expect(absentRows.products).toEqual([]);
      expect(absentRows.heads).toEqual([]);
      expect(absentRows.revisions).toEqual([]);
      expect(
        Schema.is(CatalogSourceResolutionNotFoundProblemSchema)(yield* current(absentPayload.scope).pipe(Effect.flip)),
      ).toBe(true);
      expect(
        Schema.is(ActivateLocalOverrideActionAlreadyCommittedProblemSchema)(
          yield* activate(absentPayload, missingKey).pipe(Effect.flip),
        ),
      ).toBe(true);
      const missingSnapshot = absentRows.snapshots.find(
        (row) => row.actionKey === activateLocalOverrideAction.descriptor.actionKey,
      );
      assert(missingSnapshot !== undefined);
      const recoveryAuthorization = yield* authorization();
      const recoveryCorrelationId = yield* nextId;
      const recovered = yield* Effect.tryPromise(() =>
        app.handler(
          new Request('https://catalog.ontos.test/reads/activate-local-override-recovery', {
            body: JSON.stringify({ invocationId: missingSnapshot.actionInvocationId }),
            headers: {
              authorization: recoveryAuthorization,
              'content-type': 'application/json',
              'x-correlation-id': recoveryCorrelationId,
            },
            method: 'POST',
          }),
          emptyContext,
        ),
      );
      expect(recovered.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(CatalogLocalOverrideResultSchema)(
          yield* Effect.tryPromise(() => recovered.json()),
        )).status,
      ).toBe('INVALID');
      const created = yield* create({ name: 'Genuine Product' });
      const { productRef } = created.product;
      const payload = {
        ...absentPayload,
        scope: { ...absentPayload.scope, targetId: productRef.resourceId },
        value: 'Owner name',
      };
      const activated = yield* activate(payload);
      expect(activated).toMatchObject({
        lifecycle: 'ACTIVE',
        resolved: { status: 'CURRENT' },
        revision: 1n,
        status: 'APPLIED',
      });
      expect(yield* current(payload.scope)).toEqual({
        source: { evidenceRef: payload.evidenceRef, kind: 'LOCAL_OVERRIDE', revision: 1n },
        status: 'CURRENT',
        value: 'Owner name',
      });
      expect((yield* observe()).products).toHaveLength(1);
      const foreign = yield* create({ name: 'Foreign Tenant Product' }, undefined, ungranted.manager);
      const beforeTargetControls = yield* observe();
      const foreignTarget = {
        ...payload,
        scope: { ...payload.scope, targetId: foreign.product.productRef.resourceId },
      };
      expect((yield* activate(foreignTarget)).status).toBe('INVALID');
      expect(
        Schema.is(CatalogSourceResolutionNotFoundProblemSchema)(yield* current(foreignTarget.scope).pipe(Effect.flip)),
      ).toBe(true);
      const variantAsProduct = { ...payload, scope: { ...payload.scope, targetId: created.variantId } };
      expect((yield* activate(variantAsProduct)).status).toBe('INVALID');
      expect(
        Schema.is(CatalogSourceResolutionNotFoundProblemSchema)(
          yield* current(variantAsProduct.scope).pipe(Effect.flip),
        ),
      ).toBe(true);
      const foreignPayload = { ...payload, scope: { ...payload.scope, tenantId: ungranted.tenantId } };
      const foreignPayloadFailure = yield* activate(foreignPayload).pipe(Effect.flip);
      assert(Schema.is(ActivateLocalOverrideActionIneligibleProblemSchema)(foreignPayloadFailure));
      expect(foreignPayloadFailure.code).toBe('catalog_source_request_invalid');
      expect(foreignPayloadFailure.status).toBe(422);
      const forbiddenLegalEntity = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
      expect(
        Schema.is(ActivateLocalOverrideActionForbiddenProblemSchema)(
          yield* activate(payload, undefined, forbiddenLegalEntity).pipe(Effect.flip),
        ),
      ).toBe(true);
      const afterTargetControls = yield* observe();
      expect(afterTargetControls.products).toEqual(beforeTargetControls.products);
      expect(afterTargetControls.heads).toEqual(beforeTargetControls.heads);
      expect(afterTargetControls.revisions).toEqual(beforeTargetControls.revisions);
      const evidence = yield* fixture.evidence(coreEvidenceExecutor);
      expect(evidence.accesses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resultCount: 0, targetResourceId: missingId }),
          expect.objectContaining({ resultCount: 1, targetResourceId: productRef.resourceId }),
        ]),
      );
      const beforeDenied = yield* observe();
      expect(
        Schema.is(ActivateLocalOverrideActionForbiddenProblemSchema)(
          yield* activate(absentPayload, undefined, fixture.denied).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(yield* observe()).toEqual(beforeDenied);
      const permission = {
        moduleId: 'commerce.catalog',
        permission: 'commerce.catalog.read.catalog-source-resolution' as const,
      };
      yield* permissions.mutate({ operation: 'revoke', principal, target: permission, tenantId });
      expect(
        Schema.is(CatalogSourceResolutionForbiddenProblemSchema)(yield* current(payload.scope).pipe(Effect.flip)),
      ).toBe(true);
      yield* permissions.mutate({ operation: 'grant', principal, target: permission, tenantId });
      const change = yield* Schema.decodeUnknownEffect(ChangeLocalOverridePayloadSchema)({
        ...payload,
        classification: {
          affectsOpenSelection: true,
          evidenceRefs: [payload.evidenceRef],
          kind: 'COSMETIC_CORRECTION',
          productRef,
          reason: payload.reason,
        },
        expectedRevision: '1',
        value: 'Corrected name',
      });
      const changed = yield* executeChangeLocalOverrideWithAuthorization(
        change,
        yield* authorization(),
        yield* nextId,
        {
          baseUrl: 'https://catalog.ontos.test',
          compositionRevision: composition.composition.revision,
          idempotencyKey: yield* nextId,
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      expect(changed).toMatchObject({ revision: 2n, status: 'APPLIED' });
      const stale = yield* executeChangeLocalOverrideWithAuthorization(change, yield* authorization(), yield* nextId, {
        baseUrl: 'https://catalog.ontos.test',
        compositionRevision: composition.composition.revision,
        idempotencyKey: yield* nextId,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      expect(stale.status).toBe('STALE_EDITOR');
      const releasePayload = yield* Schema.decodeUnknownEffect(ReleaseLocalOverridePayloadSchema)({
        ...payload,
        expectedRevision: '2',
      });
      const released = yield* executeReleaseLocalOverrideWithAuthorization(
        releasePayload,
        yield* authorization(),
        yield* nextId,
        {
          baseUrl: 'https://catalog.ontos.test',
          compositionRevision: composition.composition.revision,
          idempotencyKey: yield* nextId,
        },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
      expect(released).toMatchObject({
        lifecycle: 'RELEASED',
        resolved: { status: 'ABSENT' },
        revision: 3n,
        status: 'APPLIED',
      });
      expect((yield* current(payload.scope)).status).toBe('ABSENT');
      const retained = yield* observe();
      expect(retained.revisions).toHaveLength(3);
      expect(retained.revisions.find((row) => row.revision === 1n)?.value).toBe('Owner name');
      const rollbackProduct = yield* create({ name: 'Rollback target' });
      const rollbackPayload = {
        ...payload,
        scope: { ...payload.scope, targetId: rollbackProduct.product.productRef.resourceId },
      };
      const beforeRollback = yield* observe();
      fixture.faultNextTransaction('rollback');
      expect(
        Schema.is(ActivateLocalOverrideActionUnavailableProblemSchema)(
          yield* activate(rollbackPayload).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(yield* observe()).toEqual(beforeRollback);
      const lockProduct = yield* create({ name: 'Identity lock target' });
      const lockTargetId = lockProduct.product.productRef.resourceId;
      const locked = yield* Deferred.make<number>();
      const release = yield* Deferred.make<null>();
      const lockFiber = yield* holdProductIdentityLock(fixture, lockTargetId, locked, release).pipe(Effect.forkScoped);
      const blockerPid = yield* Deferred.await(locked);
      const beforeOwnerFault = yield* observe();
      // Catch outside prepareOwner so the failed SQL transaction must roll back before any assertion succeeds.
      const lookupError = yield* lookupWithLocalLockTimeout(fixture, lockTargetId).pipe(Effect.flip);
      expect(Schema.is(CatalogSourceResolutionUnavailable)(lookupError)).toBe(true);
      expect(yield* observe()).toEqual(beforeOwnerFault);
      const lockPayload = { ...payload, scope: { ...payload.scope, targetId: lockTargetId } };
      const activationFiber = yield* activate(lockPayload).pipe(Effect.forkScoped);
      yield* Effect.gen(function* verifyKeyShareWait() {
        expect(yield* observesProductLockWait(fixture, blockerPid)).toBe(true);
        expect(activationFiber.pollUnsafe()).toBeUndefined();
      }).pipe(Effect.ensuring(Deferred.succeed(release, null)));
      yield* Fiber.join(lockFiber);
      expect((yield* Fiber.join(activationFiber)).status).toBe('APPLIED');
      expect((yield* observe()).revisions.filter((row) => row.targetId === lockTargetId)).toHaveLength(1);
      const raceProduct = yield* create({ name: 'CAS target' });
      const racePayload = {
        ...payload,
        scope: { ...payload.scope, targetId: raceProduct.product.productRef.resourceId },
      };
      const race = yield* Effect.all([activate(racePayload), activate(racePayload)], { concurrency: 2 });
      expect(race.filter((result) => result.status === 'APPLIED')).toHaveLength(1);
      expect(race.filter((result) => result.status === 'CONFLICT' || result.status === 'ALREADY_ACTIVE')).toHaveLength(
        1,
      );
      expect((yield* observe()).revisions.filter((row) => row.targetId === racePayload.scope.targetId)).toHaveLength(1);
    }).pipe(Effect.provide(nativeServices)),
);
