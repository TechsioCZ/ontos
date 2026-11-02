import {
  CoreSearchIngestion,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  CoreSearchWorkerSnapshot,
  ResourceContainmentRelationshipMutation,
  TrustedPrincipalContextSchema,
  createCoreSearchQueryRuntime,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchWorkerSnapshotService } from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Exit, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { merchandiseRelations } from '../../src/database/schema.ts';
import { ordersRead } from '../../src/search/orders.provider.ts';
import { productsRead } from '../../src/search/products.provider.ts';
import {
  loadMerchandiseSearchSnapshot,
  publishMerchandiseSearch,
} from '../../src/services/merchandise-search-projection.ts';
import { merchandiseSearchIngestionRegistrations } from '../../src/worker-host/search-ingestion-registrations.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:search-publication',
  authMethod: 'session',
  legalEntityId,
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId,
});
const scope = { ...principal, correlationId: 'search-publication' };
const headSql = 'from "demo_merchandise"."catalog_heads"';
const productSql = 'from "demo_merchandise"."products"';
const variantSql = 'from "demo_merchandise"."product_variants"';
const orderSql = 'from "demo_merchandise"."orders"';
const workerContext = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'publication-claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'demo.merchandise',
  deliveryId: 'publication-delivery',
  domainEventId: 'publication-event',
  messageId: 'publication-message',
  producerModuleKey: 'demo.merchandise',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'demo.merchandise.search-rebuild-requested.v1',
  workerKey: 'demo.merchandise.rebuild-search',
});

type CatalogCheckpoint = { readonly status: string } | null;
const sourceSnapshot = Effect.fn('MerchandiseSearchPublicationTest.source')(function* source(
  checkpoint: CatalogCheckpoint,
  projectionVersion: string,
  missing: boolean,
) {
  const queries: string[] = [];
  const services = yield* Layer.build(
    scriptedPgClientLayer(
      Effect.succeed(
        testSqlConnection((sql, params) => {
          queries.push(sql);
          expect(params).toContain(tenantId);
          expect(params).toContain(legalEntityId);
          if (sql.includes(headSql)) {
            return Effect.succeed(missing ? [] : [{ bootstrapCheckpoint: checkpoint }]);
          }
          if (sql.includes(productSql)) {
            return Effect.succeed([
              { active: true, archived: false, id: 'product-1', legalEntityId, name: 'Káva', sku: 'KAVA', tenantId },
            ]);
          }
          if (sql.includes(variantSql)) {
            return Effect.succeed([]);
          }
          if (sql.includes(orderSql)) {
            return Effect.succeed([{ id: 'order-1', legalEntityId, number: 'OBJ-1', removed: false, tenantId }]);
          }
          return Effect.die(`Unexpected search source SQL: ${sql}`);
        }),
      ),
    ).pipe(Layer.provide(Reactivity.layer)),
  );
  const db = yield* makeWithDefaults({ relations: merchandiseRelations }).pipe(
    Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
  );
  const reader: CoreSearchWorkerSnapshotService = {
    read: (_context, consume) =>
      consume({
        eventWatermark: '12',
        forLegalEntity: (company, read) => {
          expect(company).toBe(legalEntityId);
          return read({ select: db.select.bind(db) });
        },
        legalEntityIds: [legalEntityId],
        projectionVersion,
        tenant: () => Effect.die('A company publication check must not use tenant-wide SQL'),
        tenantId,
      }),
  };
  const snapshot = yield* loadMerchandiseSearchSnapshot(workerContext).pipe(
    Effect.provideService(CoreSearchWorkerSnapshot, reader),
  );
  return { queries, snapshot };
});

it.effect('a missing or unverified catalog head cannot project partial product, SKU or order rows', () =>
  Effect.scoped(
    Effect.gen(function* closedSnapshots() {
      for (const state of [
        { checkpoint: null, missing: true },
        { checkpoint: { status: 'IMPORTING' }, missing: false },
        { checkpoint: { status: 'FAILED' }, missing: false },
      ]) {
        const { queries, snapshot } = yield* sourceSnapshot(state.checkpoint, '2', state.missing);
        expect(snapshot).toMatchObject({ orders: [], products: [], projectionVersion: '2', variants: [] });
        expect(queries).toHaveLength(1);
        expect(queries[0]).toContain(headSql);
      }
    }),
  ),
);

it.effect(
  'legacy and verified heads publish normally; an importing rebuild tombstones previously indexed records',
  () =>
    Effect.scoped(
      Effect.gen(function* rebuildPublicationFence() {
        const published = yield* sourceSnapshot(null, '1', false);
        const verified = yield* sourceSnapshot({ status: 'VERIFIED' }, '2', false);
        expect(published.snapshot.products).toHaveLength(1);
        expect(verified.snapshot.orders).toHaveLength(1);
        expect(published.queries[0]).toContain(headSql);
        const store = makeInMemoryCoreSearchProjectionStore();
        const runtime = yield* createCoreSearchQueryRuntime.pipe(
          Effect.provideService(CoreSearchProjectionStore, store),
        );
        const publish = (snapshot: typeof published.snapshot) =>
          publishMerchandiseSearch(workerContext, snapshot).pipe(
            Effect.provideService(CoreSearchProjectionStore, store),
            Effect.provideService(
              CoreSearchIngestion,
              makeCoreSearchIngestion(store, merchandiseSearchIngestionRegistrations),
            ),
            Effect.provideService(ResourceContainmentRelationshipMutation, { touch: () => Effect.void }),
          );
        const search = (resource: string) =>
          runtime.search(
            {
              includeArchived: false,
              moduleId: 'demo.merchandise',
              query: resource === 'product' ? 'KAVA' : 'OBJ-1',
              resourceType: `demo.merchandise.${resource}`,
              selectedLegalEntityId: legalEntityId,
              tenantId,
            },
            scope,
          );
        yield* publish(published.snapshot);
        expect(yield* search('product')).toHaveLength(1);
        expect(yield* search('order')).toHaveLength(1);
        const importing = yield* sourceSnapshot({ status: 'IMPORTING' }, '3', false);
        yield* publish(importing.snapshot);
        expect(yield* search('product')).toEqual([]);
        expect(yield* search('order')).toEqual([]);
      }),
    ),
);

it.layer(NodeCrypto.layer)('Merchandise governed search publication fence', (suite) => {
  suite.effect('both providers refuse stale Core hits while the selected catalog is missing or importing', () =>
    Effect.gen(function* staleIndexReadFence() {
      for (const resource of ['product', 'order']) {
        for (const state of [
          { checkpoint: null, missing: true },
          { checkpoint: { status: 'IMPORTING' }, missing: false },
          { checkpoint: { status: 'FAILED' }, missing: false },
          { checkpoint: null, missing: false },
          { checkpoint: { status: 'VERIFIED' }, missing: false },
        ]) {
          const calls: string[] = [];
          const harness = yield* makeReadTestHarness({
            executeOwnerQuery: ({ params, scope: ownerScope, sql }) => {
              calls.push('head');
              expect(ownerScope).toEqual({ legalEntityId, tenantId });
              expect(params).toContain(tenantId);
              expect(params).toContain(legalEntityId);
              expect(sql).toContain(headSql);
              return Effect.succeed(
                state.missing
                  ? []
                  : [
                      {
                        aiChanges: null,
                        bootstrapCheckpoint: state.checkpoint,
                        homepageFeaturedProductIds: [],
                        revision: 1,
                      },
                    ],
              );
            },
            operationTime: new Date('2026-11-02T10:00:00.000Z'),
            ownerAuthorizationDecision: 'allowed',
            permissionDecision: 'allowed',
            scope,
          });
          const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
            archived: false,
            facets: [],
            metadata: [],
            ref: {
              moduleId: 'demo.merchandise',
              resourceId: `${legalEntityId}.${resource}-1`,
              resourceType: `demo.merchandise.${resource}`,
              tenantId,
            },
            selectedLegalEntityId: legalEntityId,
            title: 'Káva',
          });
          const request = { input: { query: 'Káva' }, principal, transport: { correlationId: scope.correlationId } };
          const read =
            resource === 'product'
              ? harness.runtime
                  .runRead({ ...request, registration: productsRead })
                  .pipe(Effect.map((rows) => rows.map(({ title }) => title)))
              : harness.runtime
                  .runRead({ ...request, registration: ordersRead })
                  .pipe(Effect.map((rows) => rows.map(({ title }) => title)));
          const exit = yield* read.pipe(
            Effect.provide(harness.layer),
            Effect.provideService(CoreSearchQueryRuntime, {
              search: () =>
                Effect.sync(() => {
                  calls.push('index');
                  return [hit];
                }),
            }),
            Effect.exit,
          );
          if (state.missing || (state.checkpoint !== null && state.checkpoint.status !== 'VERIFIED')) {
            expect(Exit.isFailure(exit)).toBe(true);
            expect(calls).toEqual(['head']);
            expect(harness.snapshot().evidenceWrites).toBe(0);
          } else {
            expect(Exit.isSuccess(exit)).toBe(true);
            if (Exit.isSuccess(exit)) {
              expect(exit.value).toEqual(['Káva']);
            }
            expect(calls).toEqual(['head', 'index']);
            expect(harness.snapshot().evidenceWrites).toBe(1);
          }
          expect(harness.snapshot().ownerQueries).toHaveLength(1);
        }
      }
    }),
  );
});
