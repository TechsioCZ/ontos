import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import {
  prepareSearchPredicate,
  validSearchPredicate,
  searchReachSql,
  searchRecordVisible,
} from '../../src/services/search-record-access.ts';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql as drizzleSql } from 'drizzle-orm';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import {
  ContextAccess,
  CoreSearchIngestion,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  CoreSearchWorkerSnapshot,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  createCoreSearchQueryRuntime,
  makeCoreSearchIngestion,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { CoreSearchProjectionHit, CoreSearchWorkerSnapshotService } from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Exit, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it, rstest } from 'effect-rstest';

import { merchandiseRelations, products as productTable, orders as orderTable } from '../../src/database/schema.ts';
import { ordersRead } from '../../src/search/orders.provider.ts';
import { productsRead } from '../../src/search/products.provider.ts';
import {
  loadMerchandiseSearchSnapshot,
  loadCurrentMerchandiseSearch,
  loadMerchandiseSearch,
  publishMerchandiseSearch,
} from '../../src/services/merchandise-search-projection.ts';
import { merchandiseSearchIngestionRegistrations } from '../../src/worker-host/search-ingestion-registrations.ts';
import type { MerchandiseSearchSnapshot } from '../../src/services/merchandise-search-projection.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { ProductsProviderResponseSchema } from '../../shared/apis/products-search.ts';
import { OrderRefSchema } from '../../shared/resources/order.ts';

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
  rows: Partial<Pick<MerchandiseSearchSnapshot, 'products' | 'variants' | 'orders'>> = {},
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
            const products = rows.products ?? [
              { active: true, archived: false, id: 'product-1', legalEntityId, name: 'Káva', sku: 'KAVA', tenantId },
            ];
            // The native driver's values mode follows SELECT order, not the fixture object's insertion order.
            return Effect.succeed(
              products.map((row) => ({
                active: row.active,
                archived: row.archived,
                id: row.id,
                legalEntityId: row.legalEntityId,
                name: row.name,
                parameters: row.parameters ?? null,
                sku: row.sku,
                tenantId: row.tenantId,
              })),
            );
          }
          if (sql.includes(variantSql)) {
            return Effect.succeed(
              (rows.variants ?? []).map((row) => {
                const selected = {
                  active: row.active,
                  legalEntityId: row.legalEntityId,
                  name: row.name,
                  parameters: row.parameters ?? null,
                  productId: row.productId,
                  sku: row.sku,
                  tenantId: row.tenantId,
                };
                return sql.includes('"price_minor"')
                  ? { ...selected, priceMinor: row.priceMinor ?? null, variantId: row.variantId ?? null }
                  : selected;
              }),
            );
          }
          if (sql.includes(orderSql)) {
            return Effect.succeed(
              rows.orders ?? [{ id: 'order-1', legalEntityId, number: 'OBJ-1', removed: false, tenantId }],
            );
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
  return { db, queries, snapshot };
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

it.effect('projects only approved JSON parameter members and checks every owner variant scope', () =>
  Effect.scoped(
    Effect.gen(function* test() {
      const product = {
        active: true,
        archived: false,
        id: 'product-1',
        legalEntityId,
        name: 'ADAPTÉRY PRO KOTOUČOVÉ KARTÁČE zinek',
        parameters: [{ label: 'Materiál', value: 'zinek' }],
        sku: 'SKU18kop009',
        tenantId,
      };
      const variant = {
        active: true,
        legalEntityId,
        name: 'Malý adaptér',
        parameters: [{ label: 'Průměr', value: '180 mm' }],
        productId: product.id,
        sku: '18kop009-M',
        tenantId,
      };
      const source = yield* sourceSnapshot({ status: 'VERIFIED' }, '1', false, {
        products: [product],
        variants: [variant],
      });
      expect(source.snapshot.products[0]?.parameters).toEqual(product.parameters);
      expect(source.snapshot.variants[0]?.parameters).toEqual(variant.parameters);
      for (const statement of source.queries.filter(
        (value) => value.includes(productSql) || value.includes(variantSql),
      )) {
        expect(statement).toContain("->'parameters'");
        expect(statement).not.toMatch(/"document"\s*,/u);
      }
      const foreign = yield* Effect.exit(
        sourceSnapshot({ status: 'VERIFIED' }, '2', false, {
          products: [product],
          variants: [{ ...variant, legalEntityId: '20000000-0000-4000-8000-000000000099' }],
        }),
      );
      expect(Exit.isFailure(foreign)).toBe(true);
      const store = makeInMemoryCoreSearchProjectionStore();
      yield* publishMerchandiseSearch(workerContext, source.snapshot).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.provideService(
          CoreSearchIngestion,
          makeCoreSearchIngestion(store, merchandiseSearchIngestionRegistrations),
        ),
      );
      const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
      // A local fixture of the reported SKU/title is searchable once a verified snapshot is actually published.
      // This establishes no fact about the live index, delivery, readiness or authorization state.
      for (const query of ['SKU18kop009', 'ADAPTÉRY', 'material zinek', 'prumer 180']) {
        expect(
          yield* loadMerchandiseSearch(scope, 'product', query, ProductRefSchema, (ids) =>
            loadCurrentMerchandiseSearch(source.db, scope, 'product', ids, { groups: [] }),
          ).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime)),
        ).toHaveLength(1);
      }
    }),
  ),
);

it.effect('current owner rematch ranks canonical exact/prefix product and variant SKUs before title-only matches', () =>
  Effect.scoped(
    Effect.gen(function* test() {
      const product = {
        active: true,
        archived: false,
        legalEntityId,
        name: 'Adaptér',
        parameters: [],
        tenantId,
      };
      const rows = {
        products: [
          { ...product, id: 'title', name: 'SKU18kop009', sku: 'UNRELATED' },
          { ...product, id: 'prefix', sku: 'SKU18kop009-L' },
          { ...product, id: 'exact', sku: 'ＳＫＵ１８kop００９' },
          { ...product, id: 'variant', sku: 'PARENT' },
        ],
        variants: [
          { active: true, legalEntityId, name: 'Malý adaptér', productId: 'variant', sku: 'sku18kop009', tenantId },
        ],
      };
      const source = yield* sourceSnapshot({ status: 'VERIFIED' }, '1', false, rows);
      const hits = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(
        rows.products.map((row) => ({
          archived: false,
          facets: [],
          metadata: [],
          ref: {
            moduleId: 'demo.merchandise',
            resourceId: `${legalEntityId}.${row.id}`,
            resourceType: 'demo.merchandise.product',
            tenantId,
          },
          relevance: { score: 1, version: '1' },
          selectedLegalEntityId: legalEntityId,
          title: 'Stale title',
        })),
      );
      const results = yield* loadMerchandiseSearch(scope, 'product', '  sku18KOP009  ', ProductRefSchema, (ids) =>
        loadCurrentMerchandiseSearch(source.db, scope, 'product', ids, { groups: [] }),
      ).pipe(
        Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed(hits) }),
        Effect.flatMap(Schema.decodeUnknownEffect(ProductsProviderResponseSchema)),
      );
      expect(results.map((row) => row.ref.resourceId)).toEqual(
        ['exact', 'variant', 'prefix', 'title'].map((id) => `${legalEntityId}.${id}`),
      );
      expect(results.map((row) => row.relevance)).toEqual([
        { score: 1000, version: '1' },
        { score: 1000, version: '1' },
        { score: 999, version: '1' },
        { score: 900, version: '1' },
      ]);
      expect(results[0]?.title).toBe('Adaptér');
      expect(results.every((row) => !('matchedVariant' in row) && !('metadata' in row))).toBe(true);
      const productQueries = source.queries.filter((query) => query.includes(productSql));
      expect(productQueries).toHaveLength(2);
      expect(productQueries[1]).toContain(' in (');
    }),
  ),
);

it.effect(
  'current rematch rejects inactive-only, renamed, removed and archived evidence; parameters remain searchable',
  () =>
    Effect.scoped(
      Effect.gen(function* test() {
        const product = {
          active: true,
          archived: false,
          id: 'product-1',
          legalEntityId,
          name: 'Adaptér',
          sku: 'PARENT',
          tenantId,
        };
        const variant = {
          active: false,
          legalEntityId,
          name: 'Vyřazený',
          parameters: [{ label: 'Starý materiál', value: 'HIDDEN' }],
          productId: product.id,
          sku: 'OLD-SKU',
          tenantId,
        };
        const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
          archived: false,
          facets: [],
          metadata: [],
          ref: {
            moduleId: 'demo.merchandise',
            resourceId: `${legalEntityId}.product-1`,
            resourceType: 'demo.merchandise.product',
            tenantId,
          },
          relevance: { score: 1000, version: '1' },
          selectedLegalEntityId: legalEntityId,
          title: 'OLD-SKU',
        });
        for (const state of [
          { products: [product], query: 'OLD-SKU', variants: [variant] },
          { products: [product], query: 'HIDDEN', variants: [variant] },
          { products: [{ ...product, active: false }], query: 'PARENT', variants: [] },
          { products: [{ ...product, archived: true }], query: 'PARENT', variants: [] },
          { products: [], query: 'PARENT', variants: [] },
        ]) {
          const source = yield* sourceSnapshot({ status: 'VERIFIED' }, '1', false, state);
          expect(
            yield* loadMerchandiseSearch(scope, 'product', state.query, ProductRefSchema, (ids) =>
              loadCurrentMerchandiseSearch(source.db, scope, 'product', ids, { groups: [] }),
            ).pipe(Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) })),
          ).toEqual([]);
        }
        const source = yield* sourceSnapshot({ status: 'VERIFIED' }, '1', false, {
          products: [{ ...product, parameters: [{ label: 'Materiál', value: 'zinek' }] }],
          variants: [variant],
        });
        expect(
          yield* loadMerchandiseSearch(scope, 'product', 'material zinek', ProductRefSchema, (ids) =>
            loadCurrentMerchandiseSearch(source.db, scope, 'product', ids, { groups: [] }),
          ).pipe(Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) })),
        ).toMatchObject([{ relevance: { score: 100, version: '1' }, title: 'Adaptér' }]);
        const legacy = yield* sourceSnapshot({ status: 'VERIFIED' }, '1', false, {
          products: [product],
          variants: [{ legalEntityId, name: 'Legacy', productId: product.id, sku: 'LEGACY', tenantId }],
        });
        expect(
          yield* loadMerchandiseSearch(scope, 'product', 'legacy', ProductRefSchema, (ids) =>
            loadCurrentMerchandiseSearch(legacy.db, scope, 'product', ids, { groups: [] }),
          ).pipe(Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) })),
        ).toMatchObject([{ relevance: { score: 1000, version: '1' } }]);
        const orderHit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
          ...hit,
          ref: { ...hit.ref, resourceId: `${legalEntityId}.order-1`, resourceType: 'demo.merchandise.order' },
        });
        const removed = yield* sourceSnapshot({ status: 'VERIFIED' }, '1', false, {
          orders: [{ id: 'order-1', legalEntityId, number: 'OBJ-1', removed: true, tenantId }],
        });
        expect(
          yield* loadMerchandiseSearch(scope, 'order', 'OBJ-1', OrderRefSchema, (ids) =>
            loadCurrentMerchandiseSearch(removed.db, scope, 'order', ids, { groups: [] }),
          ).pipe(Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([orderHit]) })),
        ).toEqual([]);
      }),
    ),
);

it.effect('current rematch fails closed on an unfinished import and answers empty for a company without a head', () =>
  Effect.scoped(
    Effect.gen(function* test() {
      const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
        archived: false,
        facets: [],
        metadata: [],
        ref: {
          moduleId: 'demo.merchandise',
          resourceId: `${legalEntityId}.product-1`,
          resourceType: 'demo.merchandise.product',
          tenantId,
        },
        selectedLegalEntityId: legalEntityId,
        title: 'Káva',
      });
      for (const state of [
        { checkpoint: null, missing: true },
        { checkpoint: { status: 'IMPORTING' }, missing: false },
      ]) {
        const source = yield* sourceSnapshot(state.checkpoint, '1', state.missing);
        const exit = yield* Effect.exit(
          loadMerchandiseSearch(scope, 'product', 'kava', ProductRefSchema, (ids) =>
            loadCurrentMerchandiseSearch(source.db, scope, 'product', ids, { groups: [] }),
          ).pipe(Effect.provideService(CoreSearchQueryRuntime, { search: () => Effect.succeed([hit]) })),
        );
        if (state.missing) {
          // No head row: the company has published nothing, so a stale Core hit matches no current row.
          expect(Exit.isSuccess(exit) ? exit.value : exit).toEqual([]);
          expect(source.queries.filter((sql) => sql.includes(productSql))).toEqual([]);
        } else {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(source.queries).toHaveLength(2);
        }
      }
    }),
  ),
);

type ProviderOwnerRows = Pick<MerchandiseSearchSnapshot, 'orders' | 'products' | 'variants'>;
const providerOwnerRows: ProviderOwnerRows = {
  orders: [{ id: 'order-1', legalEntityId, number: 'OBJ-1', removed: false, tenantId }],
  products: [{ active: true, archived: false, id: 'product-1', legalEntityId, name: 'Káva', sku: 'KAVA', tenantId }],
  variants: [],
};
const providerHit = (resource: 'product' | 'order', id: string, title: string) =>
  Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
    archived: false,
    facets: [],
    metadata: [],
    ref: {
      moduleId: 'demo.merchandise',
      resourceId: `${legalEntityId}.${id}`,
      resourceType: `demo.merchandise.${resource}`,
      tenantId,
    },
    relevance: { score: 1000, version: '1' },
    selectedLegalEntityId: legalEntityId,
    title,
  });

const transactionDepth = (statements: readonly string[]) => {
  let depth = 0;
  for (const statement of statements) {
    const text = statement.trim().toLowerCase();
    if (text.startsWith('begin')) {
      depth += 1;
    } else if (text === 'commit' || text === 'rollback') {
      depth -= 1;
    }
  }
  return depth;
};

/** Exercise the actual registration, guarded owner transactions, result authorizer and durable evidence. */
const noStatements = (): readonly string[] => [];
const runProviderBoundary = Effect.fn('MerchandiseSearchPublicationTest.providerBoundary')(function* runBoundary(
  resource: 'product' | 'order',
  query: string,
  hits: readonly CoreSearchProjectionHit[],
  rows: ProviderOwnerRows,
  options: {
    readonly checkpoint?: CatalogCheckpoint;
    readonly currentCheckpoint?: CatalogCheckpoint;
    readonly missing?: boolean;
    readonly predicate?: ListAccessPredicate;
    readonly readOutcome?: 'ALLOWED' | 'DENIED' | 'NEEDS_APPROVAL' | 'UNAVAILABLE';
  } = {},
) {
  const calls: string[] = [];
  let headReads = 0;
  const predicate = options.predicate ?? { groups: [] };
  const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: options.readOutcome ?? 'ALLOWED', predicate } });
  let statements: () => readonly string[] = noStatements;
  const accessDecision: typeof gate.bound = {
    ...gate.bound,
    list: (input, transaction) => {
      expect(transactionDepth(statements())).toBe(0);
      expect(input.carrier.accessDeclaration).toEqual(
        (resource === 'product' ? productsRead : ordersRead).descriptor.accessDeclaration,
      );
      calls.push('authorization');
      return gate.bound.list(input, transaction);
    },
  };
  const visibleProducts = rows.products.filter((row) => searchRecordVisible(predicate, row, scope));
  const visibleOrders = rows.orders.filter((row) => searchRecordVisible(predicate, row, scope));
  const harness = yield* makeReadTestHarness({
    accessDecision,
    executeOwnerQuery: ({ params, scope: ownerScope, sql }) => {
      expect(ownerScope).toEqual({ legalEntityId, tenantId });
      expect(params).toContain(tenantId);
      expect(params).toContain(legalEntityId);
      if (sql.includes(headSql)) {
        calls.push('head');
        headReads += 1;
        const checkpoint =
          headReads > 1 && options.currentCheckpoint !== undefined
            ? options.currentCheckpoint
            : (options.checkpoint ?? null);
        if (options.missing === true) {
          return Effect.succeed([]);
        }
        return Effect.succeed(
          sql.includes('"homepage_featured_product_ids"')
            ? [
                {
                  aiChanges: null,
                  bootstrapCheckpoint: checkpoint,
                  homepageFeaturedProductIds: [],
                  revision: 1,
                  taxRates: null,
                },
              ]
            : [{ bootstrapCheckpoint: checkpoint }],
        );
      }
      if (sql.includes(productSql)) {
        calls.push('products');
        expect(sql).toContain(' in (');
        const reach = new PgDialect().sqlToQuery(
          searchReachSql(predicate, drizzleSql`${productTable.legalEntityId} || '.' || ${productTable.id}`),
        );
        expect(sql.replaceAll(/\$\d+/gu, '?')).toContain(reach.sql.replaceAll(/\$\d+/gu, '?'));
        if (reach.params.length > 0) {
          expect(params.slice(-reach.params.length)).toEqual(reach.params);
        }
        return Effect.succeed(
          visibleProducts.map((row) => ({
            active: row.active,
            archived: row.archived,
            id: row.id,
            legalEntityId: row.legalEntityId,
            name: row.name,
            parameters: row.parameters ?? null,
            sku: row.sku,
            tenantId: row.tenantId,
          })),
        );
      }
      if (sql.includes(variantSql)) {
        calls.push('variants');
        return Effect.succeed(
          rows.variants
            .filter((row) => visibleProducts.some((product) => product.id === row.productId))
            .map((row) => {
              const selected = {
                active: row.active,
                legalEntityId: row.legalEntityId,
                name: row.name,
                parameters: row.parameters ?? null,
                productId: row.productId,
                sku: row.sku,
                tenantId: row.tenantId,
              };
              return sql.includes('"price_minor"')
                ? { ...selected, priceMinor: row.priceMinor ?? null, variantId: row.variantId ?? null }
                : selected;
            }),
        );
      }
      if (sql.includes(orderSql)) {
        calls.push('orders');
        expect(sql).toContain(' in (');
        const reach = new PgDialect().sqlToQuery(
          searchReachSql(predicate, drizzleSql`${orderTable.legalEntityId} || '.' || ${orderTable.id}`),
        );
        expect(sql.replaceAll(/\$\d+/gu, '?')).toContain(reach.sql.replaceAll(/\$\d+/gu, '?'));
        if (reach.params.length > 0) {
          expect(params.slice(-reach.params.length)).toEqual(reach.params);
        }
        return Effect.succeed(visibleOrders);
      }
      return Effect.die(`Unexpected provider SQL: ${sql}`);
    },
    operationTime: new Date('2026-11-03T12:00:00.000Z'),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: merchandiseRegistration,
    permissionDecision: 'allowed',
    scope,
  });
  statements = () => harness.snapshot().statements;
  const legacy = yield* ContextAccess.pipe(Effect.provide(harness.layer));
  const authorization = rstest
    .spyOn(legacy, 'resources')
    .mockImplementation(() => Effect.die('Canonical Merchandise search must never invoke legacy resource authority'));
  const request = { input: { query }, principal, transport: { correlationId: scope.correlationId } };
  const read = Effect.gen(function* executeProvider() {
    if (resource === 'product') {
      return yield* harness.runtime.runRead({ ...request, registration: productsRead });
    }
    return yield* harness.runtime.runRead({ ...request, registration: ordersRead });
  });
  const exit = yield* read.pipe(
    Effect.provide(harness.layer),
    Effect.provideService(CoreSearchQueryRuntime, {
      search: (input, searchScope) =>
        Effect.sync(() => {
          expect(transactionDepth(harness.snapshot().statements)).toBe(0);
          expect(input).toMatchObject({
            includeArchived: false,
            moduleId: 'demo.merchandise',
            selectedLegalEntityId: legalEntityId,
            tenantId,
          });
          expect(searchScope).toMatchObject({ legalEntityId, tenantId });
          calls.push('index');
          return hits;
        }),
    }),
    Effect.exit,
    Effect.ensuring(Effect.sync(() => authorization.mockRestore())),
  );
  expect(authorization).not.toHaveBeenCalled();
  expect(gate.accessDecision.askedDecisions).toEqual([]);
  expect(gate.accessDecision.askedLists).toHaveLength(1);
  const snapshot = harness.snapshot();
  expect(transactionDepth(snapshot.statements)).toBe(0);
  let depth = 0;
  for (const statement of snapshot.statements) {
    depth += transactionDepth([statement]);
    expect(depth).toBeGreaterThanOrEqual(0);
    expect(depth).toBeLessThanOrEqual(1);
    if ([headSql, productSql, variantSql, orderSql].some((table) => statement.includes(table))) {
      expect(depth).toBe(1);
    }
  }
  return { calls, exit, snapshot };
});

const staffVariant: ProviderOwnerRows['variants'][number] = {
  active: true,
  legalEntityId,
  name: 'Malý adaptér',
  parameters: [{ label: 'Průměr', value: '180 mm' }],
  priceMinor: 0,
  productId: 'product-1',
  sku: 'SKU-01',
  tenantId,
  variantId: 'local-1',
};
const staffVariantRows: ProviderOwnerRows = {
  ...providerOwnerRows,
  products: providerOwnerRows.products.map((row) => ({ ...row, name: 'Adaptér', sku: 'PARENT' })),
  variants: [staffVariant],
};

it.layer(NodeCrypto.layer)('Merchandise governed search publication fence', (suite) => {
  suite.effect(
    'real product provider emits only approved unique current SKU witness fields, including zero price',
    () =>
      Effect.gen(function* uniqueSkuWitness() {
        const hit = yield* providerHit('product', 'product-1', 'Stale title');
        const result = yield* runProviderBoundary('product', 'ＳＫＵ-０１', [hit], staffVariantRows);
        expect(Exit.isSuccess(result.exit)).toBe(true);
        if (Exit.isSuccess(result.exit)) {
          const rows = yield* Schema.decodeUnknownEffect(ProductsProviderResponseSchema, { onExcessProperty: 'error' })(
            result.exit.value,
          );
          expect(rows).toEqual([
            {
              matchedVariant: { id: 'local-1', name: 'Malý adaptér', sku: 'SKU-01' },
              ref: hit.ref,
              relevance: { score: 1000, version: '1' },
              selectedLegalEntityId: legalEntityId,
              title: 'Adaptér',
            },
          ]);
          expect(JSON.stringify(rows)).not.toContain('priceMinor');
          expect(JSON.stringify(rows)).not.toContain('stockOnHand');
        }
        const variantRead = result.snapshot.ownerQueries.find((item) => item.sql.includes(variantSql));
        expect(variantRead?.params).toContain('product-1');
        expect(variantRead?.params).not.toContain('local-1');
        const where = variantRead?.sql.split(' where ')[1];
        expect(where).toContain('"product_id"');
        expect(where).not.toContain('"variant_id"');
      }),
  );

  suite.effect(
    'real product provider emits a unique all-token parameter witness with optional actual labels only',
    () =>
      Effect.gen(function* parameterWitness() {
        const hit = yield* providerHit('product', 'product-1', 'Stale title');
        for (const name of ['Malý adaptér', ' ']) {
          const result = yield* runProviderBoundary('product', 'prumer 180', [hit], {
            ...staffVariantRows,
            variants: [{ ...staffVariant, name, sku: null }],
          });
          expect(Exit.isSuccess(result.exit)).toBe(true);
          if (Exit.isSuccess(result.exit)) {
            const rows = yield* Schema.decodeUnknownEffect(ProductsProviderResponseSchema, {
              onExcessProperty: 'error',
            })(result.exit.value);
            expect(rows[0]?.matchedVariant).toEqual(name.trim() === '' ? { id: 'local-1' } : { id: 'local-1', name });
            expect(rows[0]?.title).toBe('Adaptér');
          }
        }
      }),
  );

  suite.effect(
    'real product provider keeps ambiguous exact SKUs, parameter witnesses and duplicate local IDs parent-only',
    () =>
      Effect.gen(function* ambiguousWitnesses() {
        const hit = yield* providerHit('product', 'product-1', 'Stale title');
        for (const state of [
          { query: 'SKU-01', variants: [staffVariant, { ...staffVariant, variantId: 'local-2' }] },
          { query: 'SKU-01', variants: [staffVariant, { ...staffVariant, priceMinor: null, variantId: null }] },
          { query: 'prumer 180', variants: [staffVariant, { ...staffVariant, sku: 'OTHER', variantId: 'local-2' }] },
          { query: 'SKU-01', variants: [staffVariant, { ...staffVariant, parameters: [], sku: 'OTHER' }] },
        ]) {
          const result = yield* runProviderBoundary('product', state.query, [hit], {
            ...staffVariantRows,
            variants: state.variants,
          });
          expect(Exit.isSuccess(result.exit)).toBe(true);
          if (Exit.isSuccess(result.exit)) {
            expect(result.exit.value).toHaveLength(1);
            expect(result.exit.value.every((row) => !('matchedVariant' in row))).toBe(true);
          }
        }
      }),
  );

  suite.effect(
    'real product provider never fabricates identity for informational, no-ID, unpriced or inactive variants',
    () =>
      Effect.gen(function* realVariantGate() {
        const hit = yield* providerHit('product', 'product-1', 'Stale title');
        const informational = {
          legalEntityId,
          name: 'SKU-01',
          parameters: [],
          productId: 'product-1',
          sku: 'SKU-01',
          tenantId,
        };
        for (const variant of [
          informational,
          { ...staffVariant, variantId: null },
          { ...informational, priceMinor: 0 },
          { ...informational, variantId: 'local-1' },
          { ...staffVariant, priceMinor: null },
          { ...staffVariant, variantId: '' },
          { ...staffVariant, active: false },
        ]) {
          const result = yield* runProviderBoundary('product', 'SKU-01', [hit], {
            ...staffVariantRows,
            products: staffVariantRows.products.map((row) => ({ ...row, sku: 'SKU-01' })),
            variants: [variant],
          });
          expect(Exit.isSuccess(result.exit)).toBe(true);
          if (Exit.isSuccess(result.exit)) {
            expect(result.exit.value).toHaveLength(1);
            expect(result.exit.value.every((row) => !('matchedVariant' in row))).toBe(true);
          }
        }
      }),
  );

  suite.effect('real product provider never borrows a foreign parent/company/tenant variant witness', () =>
    Effect.gen(function* scopedWitnesses() {
      const hit = yield* providerHit('product', 'product-1', 'Stale title');
      const rows = {
        ...staffVariantRows,
        products: staffVariantRows.products.map((row) => ({ ...row, sku: 'SKU-01' })),
      };
      const foreignParent = yield* runProviderBoundary('product', 'SKU-01', [hit], {
        ...rows,
        variants: [{ ...staffVariant, productId: 'other-parent' }],
      });
      expect(Exit.isSuccess(foreignParent.exit)).toBe(true);
      if (Exit.isSuccess(foreignParent.exit)) {
        expect(foreignParent.exit.value).toHaveLength(1);
        expect(foreignParent.exit.value.every((row) => !('matchedVariant' in row))).toBe(true);
      }
      for (const variant of [
        { ...staffVariant, legalEntityId: '20000000-0000-4000-8000-000000000099' },
        { ...staffVariant, tenantId: '10000000-0000-4000-8000-000000000099' },
      ]) {
        const foreignScope = yield* runProviderBoundary('product', 'SKU-01', [hit], { ...rows, variants: [variant] });
        expect(Exit.isFailure(foreignScope.exit)).toBe(true);
        expect(foreignScope.snapshot.evidenceWrites).toBe(0);
      }
    }),
  );

  suite.effect(
    'real product provider pairs reused local variant IDs with each validated parent, never a global ID lookup',
    () =>
      Effect.gen(function* localVariantIdentity() {
        const first = yield* providerHit('product', 'product-1', 'Stale A');
        const second = yield* providerHit('product', 'product-2', 'Stale B');
        const result = yield* runProviderBoundary('product', 'adapter', [second, first], {
          orders: [],
          products: [
            {
              active: true,
              archived: false,
              id: 'product-1',
              legalEntityId,
              name: 'Parent A',
              sku: 'PARENT-A',
              tenantId,
            },
            {
              active: true,
              archived: false,
              id: 'product-2',
              legalEntityId,
              name: 'Parent B',
              sku: 'PARENT-B',
              tenantId,
            },
          ],
          variants: [
            { ...staffVariant, name: 'Adaptér A', variantId: 'shared-local' },
            { ...staffVariant, name: 'Adaptér B', productId: 'product-2', variantId: 'shared-local' },
          ],
        });
        expect(Exit.isSuccess(result.exit)).toBe(true);
        if (Exit.isSuccess(result.exit)) {
          const rows = yield* Schema.decodeUnknownEffect(ProductsProviderResponseSchema)(result.exit.value);
          expect(rows.map((row) => [row.ref.resourceId, row.matchedVariant?.id, row.matchedVariant?.name])).toEqual([
            [`${legalEntityId}.product-1`, 'shared-local', 'Adaptér A'],
            [`${legalEntityId}.product-2`, 'shared-local', 'Adaptér B'],
          ]);
        }
        const query = result.snapshot.ownerQueries.find((item) => item.sql.includes(variantSql));
        expect(query?.params).toContain('product-1');
        expect(query?.params).toContain('product-2');
        expect(query?.params).not.toContain('shared-local');
      }),
  );

  suite.effect(
    'real product provider leaves parent-only and distributed non-leaf query matches without variant metadata',
    () =>
      Effect.gen(function* nonLeafMatches() {
        const hit = yield* providerHit('product', 'product-1', 'Stale title');
        for (const state of [
          {
            products: staffVariantRows.products.map((row) => ({
              ...row,
              parameters: [{ label: 'Materiál', value: 'zinek' }],
            })),
            query: 'material zinek',
            variants: [staffVariant],
          },
          {
            products: staffVariantRows.products.map((row) => ({ ...row, name: 'Parent' })),
            query: 'parent red',
            variants: [{ ...staffVariant, name: 'Red', parameters: [] }],
          },
          {
            products: staffVariantRows.products,
            query: 'red large',
            variants: [
              { ...staffVariant, name: 'Red', parameters: [], sku: 'SMALL' },
              { ...staffVariant, name: 'Blue', parameters: [], sku: 'LARGE', variantId: 'local-2' },
            ],
          },
        ]) {
          const result = yield* runProviderBoundary('product', state.query, [hit], {
            orders: [],
            products: state.products,
            variants: state.variants,
          });
          expect(Exit.isSuccess(result.exit)).toBe(true);
          if (Exit.isSuccess(result.exit)) {
            expect(result.exit.value).toHaveLength(1);
            expect(result.exit.value.every((row) => !('matchedVariant' in row))).toBe(true);
          }
        }
      }),
  );

  suite.effect(
    'real provider authorizes the parent before releasing variant evidence and never emits it for orders',
    () =>
      Effect.gen(function* authorizedWitnesses() {
        const hit = yield* providerHit('product', 'product-1', 'Stale title');
        const denied = yield* runProviderBoundary('product', 'SKU-01', [hit], staffVariantRows, {
          predicate: {
            groups: [
              {
                clauses: [
                  {
                    conditions: [
                      Schema.decodeUnknownSync(ListAccessConditionSchema)({
                        _tag: 'RecordKeyIn',
                        recordKeys: [`${legalEntityId}.another-record`],
                      }),
                    ],
                  },
                ],
              },
            ],
          },
        });
        expect(denied.exit).toMatchObject({ _tag: 'Success' });
        if (Exit.isSuccess(denied.exit)) {
          expect(denied.exit.value).toEqual([]);
        }
        expect(denied.calls[0]).toBe('authorization');
        expect(denied.calls).not.toContain('variants');
        const uncertain = yield* runProviderBoundary('product', 'SKU-01', [hit], staffVariantRows, {
          readOutcome: 'UNAVAILABLE',
        });
        expect(Exit.isFailure(uncertain.exit)).toBe(true);
        expect(uncertain.snapshot.evidenceWrites).toBe(0);
        const orderHit = yield* providerHit('order', 'order-1', 'Stale order');
        const order = yield* runProviderBoundary('order', 'OBJ-1', [orderHit], staffVariantRows);
        expect(Exit.isSuccess(order.exit)).toBe(true);
        if (Exit.isSuccess(order.exit)) {
          expect(order.exit.value).toHaveLength(1);
          expect(order.exit.value.every((row) => !('matchedVariant' in row))).toBe(true);
        }
        expect(order.calls).not.toContain('variants');
      }),
  );

  suite.effect('both real providers refuse an unfinished import and answer a company without a head empty', () =>
    Effect.gen(function* publicationFence() {
      for (const resource of ['product', 'order'] as const) {
        const hit = yield* providerHit(resource, `${resource}-1`, 'Stale title');
        for (const state of [
          { checkpoint: null, missing: true },
          { checkpoint: { status: 'IMPORTING' }, missing: false },
          { checkpoint: { status: 'FAILED' }, missing: false },
          { checkpoint: null, missing: false },
          { checkpoint: { status: 'VERIFIED' }, missing: false },
        ]) {
          const result = yield* runProviderBoundary(
            resource,
            resource === 'product' ? 'KAVA' : 'OBJ-1',
            [hit],
            providerOwnerRows,
            state,
          );
          if (state.missing) {
            // The index is consulted, but the current rematch reads no owner row of a company without a head.
            expect(Exit.isSuccess(result.exit) ? result.exit.value : result.exit).toEqual([]);
            expect(result.calls).toEqual(['authorization', 'head', 'index', 'head']);
          } else if (state.checkpoint !== null && state.checkpoint.status !== 'VERIFIED') {
            expect(Exit.isFailure(result.exit)).toBe(true);
            expect(result.calls).toEqual(['authorization', 'head']);
            expect(result.snapshot.evidenceWrites).toBe(0);
          } else {
            expect(Exit.isSuccess(result.exit)).toBe(true);
            if (Exit.isSuccess(result.exit)) {
              expect(result.exit.value.map(({ title }) => title)).toEqual([
                resource === 'product' ? 'Káva' : 'Objednávka OBJ-1',
              ]);
            }
            expect(result.calls).toEqual(
              resource === 'product'
                ? ['authorization', 'head', 'index', 'head', 'products', 'variants']
                : ['authorization', 'head', 'index', 'head', 'orders'],
            );
            expect(result.snapshot.evidenceWrites).toBe(1);
          }
        }
      }
    }),
  );

  suite.effect(
    'real providers rematch current renamed/inactive/archived/missing products and changed/removed orders',
    () =>
      Effect.gen(function* currentBoundary() {
        const productHit = yield* providerHit('product', 'product-1', 'Old label');
        for (const state of [
          {
            products: [
              {
                active: true,
                archived: false,
                id: 'product-1',
                legalEntityId,
                name: 'Nový název',
                sku: 'NEW',
                tenantId,
              },
            ],
            query: 'Old label',
          },
          { products: providerOwnerRows.products.map((row) => ({ ...row, active: false })), query: 'KAVA' },
          { products: providerOwnerRows.products.map((row) => ({ ...row, archived: true })), query: 'KAVA' },
          { products: [], query: 'KAVA' },
        ]) {
          const result = yield* runProviderBoundary('product', state.query, [productHit], {
            ...providerOwnerRows,
            products: state.products,
          });
          expect(Exit.isSuccess(result.exit)).toBe(true);
          if (Exit.isSuccess(result.exit)) {
            expect(result.exit.value).toEqual([]);
          }
          expect(result.calls[0]).toBe('authorization');
        }
        const renamed = yield* runProviderBoundary('product', 'KAVA', [productHit], {
          ...providerOwnerRows,
          products: providerOwnerRows.products.map((row) => ({ ...row, name: 'Aktuální název' })),
        });
        expect(Exit.isSuccess(renamed.exit)).toBe(true);
        if (Exit.isSuccess(renamed.exit)) {
          expect(renamed.exit.value).toMatchObject([
            { relevance: { score: 1000, version: '1' }, title: 'Aktuální název' },
          ]);
        }
        const orderHit = yield* providerHit('order', 'order-1', 'Objednávka OLD');
        for (const orders of [
          providerOwnerRows.orders.map((row) => ({ ...row, number: 'NEW' })),
          providerOwnerRows.orders.map((row) => ({ ...row, removed: true })),
          [],
        ]) {
          const result = yield* runProviderBoundary('order', 'OBJ-1', [orderHit], { ...providerOwnerRows, orders });
          expect(Exit.isSuccess(result.exit)).toBe(true);
          if (Exit.isSuccess(result.exit)) {
            expect(result.exit.value).toEqual([]);
          }
        }
      }),
  );

  suite.effect(
    'real product provider matches current parameters and legacy-active variants but never inactive-only evidence',
    () =>
      Effect.gen(function* parameterBoundary() {
        const hit = yield* providerHit('product', 'product-1', 'Stale index title');
        const rows = {
          ...providerOwnerRows,
          products: providerOwnerRows.products.map((row) => ({
            ...row,
            name: 'Adaptér',
            parameters: [{ label: 'Materiál', value: 'zinek' }],
            sku: 'PARENT',
          })),
          variants: [
            {
              legalEntityId,
              name: 'Legacy',
              parameters: [{ label: 'Průměr', value: '180 mm' }],
              productId: 'product-1',
              sku: 'LEGACY',
              tenantId,
            },
            {
              active: false,
              legalEntityId,
              name: 'Hidden',
              parameters: [{ label: 'Tajné', value: 'HIDDEN' }],
              productId: 'product-1',
              sku: 'WITHDRAWN',
              tenantId,
            },
          ],
        };
        for (const query of ['material zinek', 'prumer 180', 'legacy']) {
          const result = yield* runProviderBoundary('product', query, [hit], rows);
          expect(Exit.isSuccess(result.exit)).toBe(true);
          if (Exit.isSuccess(result.exit)) {
            expect(result.exit.value).toMatchObject([{ title: 'Adaptér' }]);
            expect(result.exit.value).toHaveLength(1);
          }
        }
        for (const query of ['HIDDEN', 'WITHDRAWN']) {
          const result = yield* runProviderBoundary('product', query, [hit], rows);
          expect(Exit.isSuccess(result.exit)).toBe(true);
          if (Exit.isSuccess(result.exit)) {
            expect(result.exit.value).toEqual([]);
          }
        }
      }),
  );

  suite.effect(
    'real product provider ranks current exact/prefix SKUs with canonical normalization and no private fields',
    () =>
      Effect.gen(function* rankingBoundary() {
        const base = { active: true, archived: false, legalEntityId, name: 'Adaptér', tenantId };
        const products = [
          { ...base, id: 'title', name: 'SKU18kop009', sku: 'OTHER' },
          { ...base, id: 'prefix', sku: 'SKU18kop009-L' },
          { ...base, id: 'exact', sku: 'ＳＫＵ１８kop００９' },
          { ...base, id: 'variant', sku: 'PARENT' },
        ];
        const hits: CoreSearchProjectionHit[] = [];
        for (const row of products) {
          hits.unshift(yield* providerHit('product', row.id, 'Stale index title'));
        }
        const result = yield* runProviderBoundary('product', '  sku18KOP009  ', hits, {
          orders: [],
          products,
          variants: [
            { active: true, legalEntityId, name: 'Malý adaptér', productId: 'variant', sku: 'sku18kop009', tenantId },
          ],
        });
        expect(Exit.isSuccess(result.exit)).toBe(true);
        if (Exit.isSuccess(result.exit)) {
          expect(result.exit.value.map((row) => [row.ref.resourceId, row.relevance?.score])).toEqual([
            [`${legalEntityId}.exact`, 1000],
            [`${legalEntityId}.variant`, 1000],
            [`${legalEntityId}.prefix`, 999],
            [`${legalEntityId}.title`, 900],
          ]);
          expect(result.exit.value.every((row) => !('metadata' in row) && !('matchedVariant' in row))).toBe(true);
        }
      }),
  );

  suite.effect(
    'canonical predicates filter owner SQL before projection and indeterminate authority never queries storage',
    () =>
      Effect.gen(function* authorizationBoundary() {
        for (const resource of ['product', 'order'] as const) {
          const hit = yield* providerHit(resource, `${resource}-1`, 'Stale index title');
          const denied = yield* runProviderBoundary(
            resource,
            resource === 'product' ? 'KAVA' : 'OBJ-1',
            [hit],
            providerOwnerRows,
            {
              predicate: {
                groups: [
                  {
                    clauses: [
                      {
                        conditions: [
                          Schema.decodeUnknownSync(ListAccessConditionSchema)({
                            _tag: 'RecordKeyIn',
                            recordKeys: [`${legalEntityId}.another-record`],
                          }),
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          );
          expect(denied.exit).toMatchObject({ _tag: 'Success' });
          if (Exit.isSuccess(denied.exit)) {
            expect(denied.exit.value).toEqual([]);
          }
          expect(denied.calls[0]).toBe('authorization');
          expect(denied.calls).not.toContain('variants');
          expect(denied.snapshot.evidenceWrites).toBe(1);
          const uncertain = yield* runProviderBoundary(
            resource,
            resource === 'product' ? 'KAVA' : 'OBJ-1',
            [hit],
            providerOwnerRows,
            { readOutcome: 'UNAVAILABLE' },
          );
          expect(Exit.isFailure(uncertain.exit)).toBe(true);
          expect(uncertain.snapshot.evidenceWrites).toBe(0);
        }
      }),
  );

  suite.effect('real providers recheck publication after the Core shortlist and reject forged tenant hits', () =>
    Effect.gen(function* currentPublicationBoundary() {
      for (const resource of ['product', 'order'] as const) {
        const hit = yield* providerHit(resource, `${resource}-1`, 'Stale index title');
        const unpublished = yield* runProviderBoundary(
          resource,
          resource === 'product' ? 'KAVA' : 'OBJ-1',
          [hit],
          providerOwnerRows,
          { currentCheckpoint: { status: 'IMPORTING' } },
        );
        expect(Exit.isFailure(unpublished.exit)).toBe(true);
        expect(unpublished.calls).toEqual(['authorization', 'head', 'index', 'head']);
        expect(unpublished.snapshot.evidenceWrites).toBe(0);
        const foreign = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
          ...hit,
          ref: { ...hit.ref, tenantId: '10000000-0000-4000-8000-000000000099' },
        });
        const forged = yield* runProviderBoundary(
          resource,
          resource === 'product' ? 'KAVA' : 'OBJ-1',
          [foreign],
          providerOwnerRows,
        );
        expect(Exit.isFailure(forged.exit)).toBe(true);
        expect(forged.calls).toEqual(['authorization', 'head', 'index']);
        expect(forged.snapshot.evidenceWrites).toBe(0);
      }
    }),
  );
});

it.effect('both real search providers preserve AND/OR target intersections and refuse unsupported owner facts', () =>
  Effect.gen(function* compoundPredicates() {
    for (const resource of ['product', 'order'] as const) {
      const hit = yield* providerHit(resource, `${resource}-1`, 'Stale index label');
      const target = Schema.decodeUnknownSync(ListAccessConditionSchema)({
        _tag: 'RecordKeyIn',
        recordKeys: [`${legalEntityId}.${resource}-1`],
      });
      const other = Schema.decodeUnknownSync(ListAccessConditionSchema)({
        _tag: 'RecordKeyIn',
        recordKeys: [`${legalEntityId}.another`],
      });
      const unsupported = Schema.decodeUnknownSync(ListAccessConditionSchema)({
        _tag: 'AssignedTo',
        holder: { _tag: 'Principal', principalId: principal.principalId },
      });
      const predicates: readonly { readonly expected: number; readonly predicate: ListAccessPredicate }[] = [
        { expected: 1, predicate: { groups: [] } },
        { expected: 1, predicate: { groups: [{ clauses: [{ conditions: [target] }] }] } },
        // OR admits the real target, the second AND group still constrains that result.
        {
          expected: 1,
          predicate: {
            groups: [
              { clauses: [{ conditions: [other] }, { conditions: [target] }] },
              { clauses: [{ conditions: [target] }] },
            ],
          },
        },
        {
          expected: 0,
          predicate: { groups: [{ clauses: [{ conditions: [target] }] }, { clauses: [{ conditions: [other] }] }] },
        },
        { expected: 0, predicate: { groups: [{ clauses: [{ conditions: [target, other] }] }] } },
        { expected: 0, predicate: { groups: [{ clauses: [{ conditions: [target, unsupported] }] }] } },
      ];
      for (const { expected, predicate } of predicates) {
        const actual = yield* runProviderBoundary(
          resource,
          resource === 'product' ? 'KAVA' : 'OBJ-1',
          [hit],
          providerOwnerRows,
          { predicate },
        );
        expect(Exit.isSuccess(actual.exit)).toBe(true);
        if (Exit.isSuccess(actual.exit)) {
          expect(actual.exit.value).toHaveLength(expected);
        }
        if (expected === 0) {
          expect(actual.calls).not.toContain('variants');
        }
      }
      for (const readOutcome of ['DENIED', 'NEEDS_APPROVAL', 'UNAVAILABLE'] as const) {
        const refused = yield* runProviderBoundary(resource, 'KAVA', [hit], providerOwnerRows, { readOutcome });
        expect(Exit.isFailure(refused.exit)).toBe(true);
        expect(refused.calls).toEqual(['authorization']);
      }
    }
  }).pipe(Effect.provide(NodeCrypto.layer), Effect.scoped),
);
it.effect('missing or malformed canonical search predicates never become all-in-scope', () =>
  Effect.gen(function* missingPredicate() {
    expect(yield* prepareSearchPredicate().pipe(Effect.flip)).toBeInstanceOf(ReadPermissionDenied);
    expect(validSearchPredicate({ groups: [{ clauses: [] }] })).toBe(false);
    expect(validSearchPredicate({ groups: [{ clauses: [{ conditions: [] }] }] })).toBe(false);
    expect(validSearchPredicate({ groups: [{ clauses: [{ conditions: [{ _tag: 'Unsupported' }] }] }] })).toBe(false);
  }),
);
