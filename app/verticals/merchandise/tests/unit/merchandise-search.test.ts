import {
  CoreSearchQueryRuntime,
  CoreSearchWorkerSnapshot,
  CoreSearchProjectionStore,
  CoreSearchIngestion,
  ResourceContainmentRelationshipMutation,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
  makeCoreSearchIngestion,
  CoreSearchProjectionHitSchema,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import type { CoreSearchQueryRuntimeService, ResourceContainmentRelationshipMutationInput } from '@app/core-runtime';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  loadMerchandiseSearchSnapshot,
  buildMerchandiseSearchDocuments,
  loadMerchandiseSearch as loadSearch,
  publishMerchandiseSearch,
  merchandiseSearchRefreshTarget,
} from '../../src/services/merchandise-search-projection.ts';
import type { MerchandiseSearchSnapshot } from '../../src/services/merchandise-search-projection.ts';
import { merchandiseSearchIngestionRegistrations } from '../../src/worker-host/search-ingestion-registrations.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { OrderRefSchema } from '../../shared/resources/order.ts';
import { ProductsProviderResponseSchema } from '../../shared/apis/products-search.ts';
import { OrdersProviderResponseSchema } from '../../shared/apis/orders-search.ts';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';

const loadMerchandiseSearch = (runtime: CoreSearchQueryRuntimeService, ...args: Parameters<typeof loadSearch>) =>
  loadSearch(...args).pipe(Effect.provideService(CoreSearchQueryRuntime, runtime));

const tenantId = '10000000-0000-4000-8000-000000000001';
const company = '20000000-0000-4000-8000-000000000002';
const otherCompany = '20000000-0000-4000-8000-000000000003';
const scope = {
  authContextRef: 'job:merchandise-search:test',
  authMethod: 'system',
  correlationId: 'search-test',
  legalEntityId: company,
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId,
} as const;
const context = (kind: 'refresh' | 'rebuild') =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: 'claim',
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: 'demo.merchandise',
    deliveryId: 'delivery',
    domainEventId: 'event',
    messageId: 'message',
    producerModuleKey: 'demo.merchandise',
    tenantId,
    tenantSequenceNo: 1n,
    topic: `demo.merchandise.search-${kind}-requested.v1`,
    workerKey: `demo.merchandise.${kind}-search`,
  });
const snapshot: MerchandiseSearchSnapshot = {
  orders: [{ id: 'order-1', legalEntityId: company, number: 'OBJ-2026-001', removed: false, tenantId }],
  products: [
    {
      active: true,
      archived: false,
      id: 'product-1',
      legalEntityId: company,
      name: 'Čerstvá káva',
      sku: 'KAVA-01',
      tenantId,
    },
  ],
  projectionVersion: '1',
  tenantId,
  variants: [
    { active: true, legalEntityId: company, name: 'Půl kila', productId: 'product-1', sku: 'KAVA-500', tenantId },
    { active: false, legalEntityId: company, name: 'Withdrawn', productId: 'product-1', sku: 'WITHDRAWN', tenantId },
    {
      active: true,
      legalEntityId: otherCompany,
      name: 'Foreign variant',
      productId: 'product-1',
      sku: 'FOREIGN',
      tenantId,
    },
  ],
};

it.effect('indexes human product/order labels and active SKU text, never another company variant', () =>
  Effect.gen(function* test() {
    const docs = yield* buildMerchandiseSearchDocuments(snapshot);
    expect(docs.map((d) => [d.title, d.selectedLegalEntityId])).toEqual([
      ['Čerstvá káva', company],
      ['Objednávka OBJ-2026-001', company],
    ]);
    expect(docs[0]?.searchableText).toEqual(['Čerstvá káva', 'KAVA-01', 'Půl kila', 'KAVA-500']);
    expect(docs[1]?.searchableText).toEqual(['OBJ-2026-001']);
    expect(docs.every((d) => d.ref.tenantId === tenantId)).toBe(true);
  }),
);

it.effect('rejects foreign tenant snapshots and keeps company-local identities distinct', () =>
  Effect.gen(function* test() {
    expect(
      Exit.isFailure(yield* Effect.exit(buildMerchandiseSearchDocuments({ ...snapshot, tenantId: otherCompany }))),
    ).toBe(true);
    const docs = yield* buildMerchandiseSearchDocuments({
      ...snapshot,
      products: [
        ...snapshot.products,
        {
          active: true,
          archived: false,
          id: 'product-1',
          legalEntityId: otherCompany,
          name: 'Other',
          sku: 'OTHER',
          tenantId,
        },
      ],
    });
    expect(new Set(docs.map((d) => d.ref.resourceId)).size).toBe(docs.length);
  }),
);

it.effect('rebuild, SKU updates, removals, replay and company-isolated queries use the Core index', () =>
  Effect.gen(function* test() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const query = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    const touches: ResourceContainmentRelationshipMutationInput[] = [];
    const publish = (source: MerchandiseSearchSnapshot, target?: Parameters<typeof publishMerchandiseSearch>[2]) =>
      publishMerchandiseSearch(context(target === undefined ? 'rebuild' : 'refresh'), source, target).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.provideService(
          CoreSearchIngestion,
          makeCoreSearchIngestion(store, merchandiseSearchIngestionRegistrations),
        ),
        Effect.provideService(ResourceContainmentRelationshipMutation, {
          touch: (input) =>
            Effect.sync(() => {
              touches.push(input);
            }),
        }),
      );
    const search = (text: string) => loadMerchandiseSearch(query, scope, 'product', text, ProductRefSchema);
    yield* publish(snapshot);
    expect((yield* search('kava-500')).length).toBe(1);
    expect((yield* search('cerstva')).length).toBe(1);
    expect(touches[0]?.relationships[0]?.container.objectId).toBe(
      toModuleAccessObjectId(tenantId, company, 'demo.merchandise'),
    );
    expect(
      yield* loadMerchandiseSearch(
        query,
        { ...scope, legalEntityId: otherCompany },
        'product',
        'kava',
        ProductRefSchema,
      ),
    ).toEqual([]);
    expect(
      yield* loadMerchandiseSearch(query, { ...scope, tenantId: otherCompany }, 'product', 'kava', ProductRefSchema),
    ).toEqual([]);
    const target = { legalEntityId: company, orderIds: [], productIds: ['product-1'], rebuild: false };
    const updated = { ...snapshot, projectionVersion: '2', variants: [] };
    yield* publish(updated, target);
    expect(yield* search('KAVA-500')).toEqual([]);
    yield* publish({ ...snapshot, projectionVersion: '1' }, target);
    expect(yield* search('KAVA-500')).toEqual([]);
    yield* publish({ ...snapshot, products: [], projectionVersion: '3', variants: [] }, target);
    expect(yield* search('kava')).toEqual([]);
    yield* publish({ ...snapshot, projectionVersion: '4' });
    yield* publish({ ...snapshot, orders: [], products: [], projectionVersion: '5', variants: [] });
    expect(yield* search('kava')).toEqual([]);
  }),
);

it.effect('rejects forged/stale tenant, company, type and archived hits despite a multi-company principal', () =>
  Effect.gen(function* test() {
    const [document] = yield* buildMerchandiseSearchDocuments(snapshot);
    if (document === undefined) {
      yield* Effect.die('missing fixture');
      return;
    }
    const base = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(document);
    const missingCompany = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)({
      archived: base.archived,
      facets: [],
      metadata: [],
      ref: base.ref,
      title: base.title,
    });
    for (const bad of [
      missingCompany,
      { ...base, ref: { ...base.ref, resourceId: `${otherCompany}.product-1` } },
      { ...base, selectedLegalEntityId: otherCompany },
      { ...base, archived: true },
      { ...base, ref: { ...base.ref, tenantId: otherCompany } },
      { ...base, ref: { ...base.ref, resourceType: 'demo.merchandise.order' } },
    ]) {
      // Decode as the shared runtime would, preserving its branded hit types.
      const hit = yield* Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(bad);
      const result = yield* Effect.exit(
        loadMerchandiseSearch({ search: () => Effect.succeed([hit]) }, scope, 'product', 'kava', ProductRefSchema),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          loadMerchandiseSearch(
            { search: () => Effect.succeed([]) },
            {
              authContextRef: scope.authContextRef,
              authMethod: scope.authMethod,
              correlationId: scope.correlationId,
              principalId: scope.principalId,
              tenantId,
            },
            'product',
            'kava',
            ProductRefSchema,
          ),
        ),
      ),
    ).toBe(true);
  }),
);

it.effect('wire contract requires tenant and trusted company and mutation targets cover product/order lifecycle', () =>
  Effect.gen(function* test() {
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          Schema.decodeUnknownEffect(ProductsProviderResponseSchema)([
            {
              ref: { moduleId: 'demo.merchandise', resourceId: 'p', resourceType: 'demo.merchandise.product' },
              title: 'Product',
            },
          ]),
        ),
      ),
    ).toBe(true);
    const remove = yield* Schema.decodeUnknownEffect(MerchandiseCommandSchema)({
      _tag: 'RemoveDemoOrder',
      id: 'order-1',
      reason: 'test cleanup',
    });
    expect(merchandiseSearchRefreshTarget(remove, ['order-1'], company)).toEqual({
      legalEntityId: company,
      orderIds: ['order-1'],
      productIds: [],
      rebuild: false,
    });
    const reset = yield* Schema.decodeUnknownEffect(MerchandiseCommandSchema)({
      _tag: 'ResetDemoData',
      confirmation: 'OBNOVIT',
      reason: 'Reset for search test',
    });
    expect(merchandiseSearchRefreshTarget(reset, [], company).rebuild).toBe(true);
    const archived = yield* buildMerchandiseSearchDocuments({
      ...snapshot,
      orders: snapshot.orders.map((o) => ({ ...o, removed: true })),
      products: snapshot.products.map((p) => ({ ...p, archived: true })),
    });
    expect(archived.length).toBe(1);
    expect(archived[0]?.archived).toBe(true);
  }),
);

it.effect('snapshot refuses a foreign company before owner SQL is reachable', () =>
  Effect.gen(function* test() {
    let sqlReached = false;
    const result = yield* Effect.exit(
      loadMerchandiseSearchSnapshot(context('refresh'), {
        legalEntityId: otherCompany,
        orderIds: [],
        productIds: ['product-1'],
        rebuild: false,
      }).pipe(
        Effect.provideService(CoreSearchWorkerSnapshot, {
          read: (_context, read) =>
            read({
              eventWatermark: '1',
              forLegalEntity: () =>
                Effect.sync(() => {
                  sqlReached = true;
                }).pipe(Effect.andThen(Effect.die('foreign SQL'))),
              legalEntityIds: [company],
              projectionVersion: '6',
              tenant: () => Effect.die('tenant SQL is not needed'),
              tenantId,
            }),
        }),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(sqlReached).toBe(false);
  }),
);

it.effect('projects every SKU in the supported 1,000-variant merchandise model without dropping evidence', () =>
  Effect.gen(function* test() {
    const maximum: MerchandiseSearchSnapshot = {
      ...snapshot,
      variants: Array.from({ length: 1000 }, (_, index) => ({
        active: true,
        legalEntityId: company,
        name: `Balení ${index} `.padEnd(100, 'x'),
        productId: 'product-1',
        sku: `SKU-${index}`.padEnd(64, 'S'),
        tenantId,
      })),
    };
    const documents = yield* buildMerchandiseSearchDocuments(maximum);
    expect(documents[0]?.searchableText.length).toBe(2002);
    expect(documents[0]?.searchableText).toContain('SKU-999'.padEnd(64, 'S'));
    expect(documents[0]?.searchableText.join(' ').length).toBeGreaterThan(40_000);
  }),
);

it.effect('preserves full supported local identifiers when qualifying them by the trusted company', () =>
  Effect.gen(function* test() {
    const documents = yield* buildMerchandiseSearchDocuments({
      ...snapshot,
      orders: snapshot.orders.map((order) => ({ ...order, id: 'o'.repeat(300) })),
      products: snapshot.products.map((product) => ({ ...product, id: 'p'.repeat(300) })),
      variants: [],
    });
    const response = yield* Schema.decodeUnknownEffect(ProductsProviderResponseSchema)(
      documents
        .filter((document) => document.ref.resourceType === 'demo.merchandise.product')
        .map((document) => ({
          ref: document.ref,
          selectedLegalEntityId: document.selectedLegalEntityId,
          title: document.title,
        })),
    );
    expect(response[0]?.ref.resourceId).toBe(`${company}.${'p'.repeat(300)}`);
    const orderResponse = yield* Schema.decodeUnknownEffect(OrdersProviderResponseSchema)(
      documents
        .filter((document) => document.ref.resourceType === 'demo.merchandise.order')
        .map((document) => ({
          ref: document.ref,
          selectedLegalEntityId: document.selectedLegalEntityId,
          title: document.title,
        })),
    );
    expect(orderResponse[0]?.ref.resourceId).toBe(`${company}.${'o'.repeat(300)}`);
  }),
);

it.effect(
  'both owner ref codecs keep the native identifier bound and each wire scope field is independently required',
  () =>
    Effect.gen(function* test() {
      const product = {
        moduleId: 'demo.merchandise',
        resourceId: 'p',
        resourceType: 'demo.merchandise.product',
        tenantId,
      };
      const order = { moduleId: 'demo.merchandise', resourceId: 'o', resourceType: 'demo.merchandise.order', tenantId };
      expect(
        Exit.isFailure(
          yield* Effect.exit(Schema.decodeUnknownEffect(ProductRefSchema)({ ...product, resourceId: `${company}.` })),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(Schema.decodeUnknownEffect(OrderRefSchema)({ ...order, resourceId: `${company}.` })),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Schema.decodeUnknownEffect(ProductRefSchema)({ ...product, resourceId: `${company}.${'p'.repeat(301)}` }),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Schema.decodeUnknownEffect(OrderRefSchema)({ ...order, resourceId: `${company}.${'o'.repeat(301)}` }),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(Schema.decodeUnknownEffect(ProductRefSchema)({ ...product, resourceId: 'p'.repeat(301) })),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(Schema.decodeUnknownEffect(OrderRefSchema)({ ...order, resourceId: 'o'.repeat(301) })),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Schema.decodeUnknownEffect(ProductsProviderResponseSchema)([{ ref: product, title: 'Produkt' }]),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Schema.decodeUnknownEffect(ProductsProviderResponseSchema)([
              {
                ref: { moduleId: product.moduleId, resourceId: product.resourceId, resourceType: product.resourceType },
                selectedLegalEntityId: company,
                title: 'Produkt',
              },
            ]),
          ),
        ),
      ).toBe(true);
    }),
);
