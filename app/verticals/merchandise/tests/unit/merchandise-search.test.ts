import {
  CoreSearchQueryRuntime,
  CoreSearchWorkerSnapshot,
  CoreSearchProjectionStore,
  CoreSearchIngestion,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
  makeCoreSearchIngestion,
  CoreSearchProjectionHitSchema,
} from '@app/core-runtime';
import type { CoreSearchQueryRuntimeService, OperationalScope } from '@app/core-runtime';
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
import { ProductsProviderRequestSchema, ProductsProviderResponseSchema } from '../../shared/apis/products-search.ts';
import { OrdersProviderRequestSchema, OrdersProviderResponseSchema } from '../../shared/apis/orders-search.ts';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';

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

const loadMerchandiseSearch = <Ref, Encoded>(
  runtime: CoreSearchQueryRuntimeService,
  searchScope: OperationalScope,
  resource: 'product' | 'order',
  query: string,
  refSchema: Schema.Codec<Ref, Encoded>,
  current: MerchandiseSearchSnapshot = snapshot,
) =>
  loadSearch(searchScope, resource, query, refSchema, () => Effect.succeed(current)).pipe(
    Effect.provideService(CoreSearchQueryRuntime, runtime),
  );

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

it.effect('indexes only approved product/active-variant parameter labels and values, without publishing objects', () =>
  Effect.gen(function* test() {
    const docs = yield* buildMerchandiseSearchDocuments({
      ...snapshot,
      products: snapshot.products.map((row) => ({
        ...row,
        parameters: [
          { label: 'Povrchová úprava', value: 'zinek' },
          { label: ' ', value: '' },
        ],
      })),
      variants: snapshot.variants.map((row) => ({
        ...row,
        parameters: [
          { label: 'Průměr', value: row.active !== false && row.legalEntityId === company ? 'Ø 180 mm' : 'HIDDEN' },
        ],
      })),
    });
    expect(docs[0]?.searchableText).toEqual([
      'Čerstvá káva Povrchová úprava zinek',
      'KAVA-01',
      'Půl kila Průměr Ø 180 mm',
      'KAVA-500',
    ]);
    expect(docs[0]?.metadata).toEqual([]);
    expect(docs[0]?.aliases).toEqual([]);
    expect(docs[0]?.facets).toEqual([]);
    expect(JSON.stringify(docs)).not.toContain('HIDDEN');
    const store = makeInMemoryCoreSearchProjectionStore();
    const parameterSnapshot = {
      ...snapshot,
      products: snapshot.products.map((row) => ({ ...row, parameters: [{ label: 'Materiál', value: 'zinek' }] })),
      variants: snapshot.variants.map((row) => ({ ...row, parameters: [{ label: 'Průměr', value: 'Ø 180 mm' }] })),
    };
    yield* publishMerchandiseSearch(context('rebuild'), parameterSnapshot).pipe(
      Effect.provideService(CoreSearchProjectionStore, store),
      Effect.provideService(
        CoreSearchIngestion,
        makeCoreSearchIngestion(store, merchandiseSearchIngestionRegistrations),
      ),
    );
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    for (const query of ['material zinek', 'prumer 180', 'ＫＡＶＡ-５００']) {
      expect(
        yield* loadMerchandiseSearch(runtime, scope, 'product', query, ProductRefSchema, parameterSnapshot),
      ).toHaveLength(1);
    }
    expect(yield* loadMerchandiseSearch(runtime, scope, 'product', 'WITHDRAWN', ProductRefSchema)).toEqual([]);
  }),
);

it.effect('canonical legacy unset-active variants retain evidence while explicit false never matches', () =>
  Effect.gen(function* test() {
    const documents = yield* buildMerchandiseSearchDocuments({
      ...snapshot,
      variants: [
        {
          legalEntityId: company,
          name: 'Legacy',
          parameters: [{ label: 'Materiál', value: 'zinek' }],
          productId: 'product-1',
          sku: 'LEGACY',
          tenantId,
        },
        {
          active: false,
          legalEntityId: company,
          name: 'Hidden',
          parameters: [{ label: 'Tajné', value: 'HIDDEN' }],
          productId: 'product-1',
          sku: 'HIDDEN',
          tenantId,
        },
      ],
    });
    const text = documents[0]?.searchableText.join(' ');
    expect(text).toContain('Legacy Materiál zinek');
    expect(text).toContain('LEGACY');
    expect(text).not.toContain('HIDDEN');
  }),
);

it.effect('retains Core evidence bounds rather than silently truncating unsupported parameter text', () =>
  Effect.gen(function* test() {
    const tooLong = yield* Effect.exit(
      buildMerchandiseSearchDocuments({
        ...snapshot,
        products: snapshot.products.map((row) => ({
          ...row,
          parameters: [{ label: 'Materiál', value: 'x'.repeat(301) }],
        })),
      }),
    );
    expect(Exit.isFailure(tooLong)).toBe(true);
  }),
);

it.effect('request and optional relevance codecs use Core query/version/range contracts', () =>
  Effect.gen(function* test() {
    for (const schema of [ProductsProviderRequestSchema, OrdersProviderRequestSchema]) {
      for (const query of ['', ' ', '\u0301', 'x'.repeat(201)]) {
        expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(schema)({ query })))).toBe(true);
      }
    }
    const [document] = yield* buildMerchandiseSearchDocuments(snapshot);
    if (document === undefined) {
      yield* Effect.die('missing fixture');
      return;
    }
    const response = { ref: document.ref, selectedLegalEntityId: company, title: document.title };
    expect(yield* Schema.decodeUnknownEffect(ProductsProviderResponseSchema)([response])).toEqual([response]);
    for (const relevance of [
      { score: -1, version: '1' },
      { score: 1001, version: '1' },
      { score: 1, version: '2' },
    ]) {
      expect(
        Exit.isFailure(
          yield* Effect.exit(Schema.decodeUnknownEffect(ProductsProviderResponseSchema)([{ ...response, relevance }])),
        ),
      ).toBe(true);
    }
    expect(
      yield* Schema.decodeUnknownEffect(ProductsProviderResponseSchema)([
        { ...response, relevance: { score: 1000, version: '1' } },
      ]),
    ).toHaveLength(1);
  }),
);

it.effect('staff variant wire evidence is optional, local, bounded and rejects private fields or order metadata', () =>
  Effect.gen(function* test() {
    const product = {
      ref: {
        moduleId: 'demo.merchandise',
        resourceId: `${company}.product-1`,
        resourceType: 'demo.merchandise.product',
        tenantId,
      },
      selectedLegalEntityId: company,
      title: 'Adaptér',
    };
    for (const matchedVariant of [
      { id: 'local-1' },
      { id: 'local-1', name: 'Malý adaptér' },
      { id: 'local-1', name: 'Malý adaptér', sku: 'SKU-01' },
    ]) {
      expect(
        yield* Schema.decodeUnknownEffect(ProductsProviderResponseSchema, { onExcessProperty: 'error' })([
          { ...product, matchedVariant },
        ]),
      ).toEqual([{ ...product, matchedVariant }]);
    }
    for (const matchedVariant of [
      { name: 'Malý adaptér' },
      { id: '' },
      { id: 'x'.repeat(301) },
      { id: 'local-1', name: ' ' },
      { id: 'local-1', sku: ' ' },
      { id: 'local-1', priceMinor: 0 },
      { id: 'local-1', stockOnHand: 10 },
      { document: { name: 'Private document' }, id: 'local-1' },
    ]) {
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Schema.decodeUnknownEffect(ProductsProviderResponseSchema, { onExcessProperty: 'error' })([
              { ...product, matchedVariant },
            ]),
          ),
        ),
      ).toBe(true);
    }
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          Schema.decodeUnknownEffect(OrdersProviderResponseSchema, { onExcessProperty: 'error' })([
            {
              ...product,
              matchedVariant: { id: 'local-1' },
              ref: { ...product.ref, resourceId: `${company}.order-1`, resourceType: 'demo.merchandise.order' },
            },
          ]),
        ),
      ),
    ).toBe(true);
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
    const publish = (source: MerchandiseSearchSnapshot, target?: Parameters<typeof publishMerchandiseSearch>[2]) =>
      publishMerchandiseSearch(context(target === undefined ? 'rebuild' : 'refresh'), source, target).pipe(
        Effect.provideService(CoreSearchProjectionStore, store),
        Effect.provideService(
          CoreSearchIngestion,
          makeCoreSearchIngestion(store, merchandiseSearchIngestionRegistrations),
        ),
      );
    const search = (text: string) => loadMerchandiseSearch(query, scope, 'product', text, ProductRefSchema);
    yield* publish(snapshot);
    expect((yield* search('kava-500')).length).toBe(1);
    expect((yield* search('cerstva')).length).toBe(1);
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
    const withParameters = yield* buildMerchandiseSearchDocuments({
      ...maximum,
      variants: maximum.variants.map((variant, index) => ({
        ...variant,
        parameters: [{ label: 'Materiál', value: `zinek-${index}` }],
      })),
    });
    expect(withParameters[0]?.searchableText.length).toBe(2002);
    expect(withParameters[0]?.searchableText.join(' ')).toContain('zinek-999');
    expect(withParameters[0]?.searchableText.every((term) => term.length <= 300)).toBe(true);
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
