// Storefront reads (merchandise-queries.ts) against PostgreSQL: the catalog is written with `replaceSnapshot` into
// a fresh company scope, then the bounded SQL reads are asserted.
import { DateTime, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import type { MerchandiseState, RecordsView, StorefrontCatalogQuery } from '../../shared/apis/records.ts';
import {
  categoryTree,
  indicators,
  orderPage,
  productCategoryCounts,
  productMovements,
  staffProducts,
  storefrontOrderStatus,
  storefrontCustomerOrders,
  storefrontProducts,
} from '../../src/services/merchandise-queries.ts';
import { resetToAkrosBaseline } from '../../src/services/akros-demo-reset.ts';
import { loadHead } from '../../src/services/merchandise-store.ts';
import type { MerchandiseFixture } from './support/merchandise-database.ts';
import { catalogInput, catalogState, decodeState, withMerchandise } from './support/merchandise-database.ts';

const catalogPage = ({ db, scope }: MerchandiseFixture, query: StorefrontCatalogQuery) =>
  storefrontProducts(db, scope, { query });

/** Listing ids (cards: a full page holds at most two products). */
const idsOf = (fixture: MerchandiseFixture, query: StorefrontCatalogQuery) =>
  catalogPage(fixture, { fields: 'card', ...query }).pipe(
    Effect.map((page) => page.products.map((product) => product.id)),
  );

const onCatalog = <A, E>(run: (fixture: MerchandiseFixture) => Effect.Effect<A, E>) =>
  withMerchandise(catalogState, run);

it.live('hides unpublished products and returns the storefront category tree without history', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      const page = yield* catalogPage(fixture, { fields: 'card' });
      expect(page.total).toBe(3);
      expect(page.products.map((product) => product.id)).toEqual(['p1', 'p2', 'p3']);
      const tree = yield* categoryTree(fixture.db, fixture.scope, { storefront: true });
      expect(tree.map((category) => category.id)).toEqual(['r', 'c']);
      expect(tree.every((category) => !('history' in category))).toBe(true);
    }),
  ),
);

it.live('filters by category slug including descendants through categoryPathIds', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      expect(yield* idsOf(fixture, { categorySlug: 'srouby' })).toEqual(['p1', 'p3']);
      expect(yield* idsOf(fixture, { categorySlug: 'metricke' })).toEqual(['p1']);
      expect((yield* catalogPage(fixture, { categorySlug: 'neexistuje' })).total).toBe(0);
    }),
  ),
);

it.live('lists featured products in homepage order followed by recommended ones', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      expect(yield* idsOf(fixture, { featured: true })).toEqual(['p3', 'p1']);
    }),
  ),
);

it.live('filters by label', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      expect(yield* idsOf(fixture, { label: 'sale' })).toEqual(['p2']);
      expect(yield* idsOf(fixture, { label: 'recommended' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { label: 'new' })).toEqual([]);
    }),
  ),
);

it.live('searches name, sku and variant text case-insensitively', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      expect(yield* idsOf(fixture, { q: 'm8' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'p1-m8' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'p2' })).toEqual(['p2']);
    }),
  ),
);

it.live('ignores diacritics and word order and searches parameters', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      expect(yield* idsOf(fixture, { q: 'sroub' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'ŠROUB' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'zinkovany sroub' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'nerez a2' })).toEqual(['p1']);
      expect(yield* idsOf(fixture, { q: 'sroub neexistuje' })).toEqual([]);
      // LIKE wildcards in the query are literal text, not patterns.
      expect(yield* idsOf(fixture, { q: '%' })).toEqual([]);
      expect(yield* idsOf(fixture, { q: '_' })).toEqual([]);
    }),
  ),
);

it.live('sends heading and long description only for the requested category', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      const tree = yield* categoryTree(fixture.db, fixture.scope, { activeSlug: 'metricke', storefront: true });
      const active = tree.find((category) => category.id === 'c');
      const root = tree.find((category) => category.id === 'r');
      expect(active?.longDescription).toBe('Dlouhý popis');
      expect(active?.heading).toBe('Metrické');
      expect(root?.longDescription).toBeUndefined();
      expect(root?.heading).toBeUndefined();
      // Roots always carry their tile content.
      expect(root?.description).toBe('Krátký popis');
      expect(root?.imageAlt).toBe('Šrouby');
    }),
  ),
);

it.live('pages results while keeping the total', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      const result = yield* catalogPage(fixture, { page: 2, pageSize: 2 });
      expect(result.products.map((product) => product.id)).toEqual(['p3']);
      expect(result.total).toBe(3);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(2);
      expect(result.head).toEqual({ homepageFeaturedProductIds: ['p3'], revision: fixture.revision });
      // A full page never holds more than two products; cards honour the requested size.
      expect((yield* catalogPage(fixture, { pageSize: 10 })).products.length).toBe(2);
      expect((yield* catalogPage(fixture, { fields: 'card', pageSize: 10 })).products.length).toBe(3);
      const beyondEnd = yield* catalogPage(fixture, { page: 10, pageSize: 2 });
      expect(beyondEnd.products).toEqual([]);
      expect(beyondEnd.total).toBe(3);
      const missing = yield* catalogPage(fixture, { slug: 'not-a-product' });
      expect(missing.products).toEqual([]);
      expect(missing.total).toBe(0);
      const summary = yield* staffProducts(fixture.db, fixture.scope, { limit: 0, summary: true }, false);
      expect(summary.products).toEqual([]);
      expect(summary.total).toBe(4);
    }),
  ),
);

it.live('fails closed when the company has no catalog head', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* assertMissingHead() {
      const failure = yield* storefrontProducts(
        db,
        { ...scope, legalEntityId: '00000000-0000-4000-8000-000000000001' },
        { query: { fields: 'card' } },
      ).pipe(Effect.flip);
      expect(failure.reason).toBe('The storefront catalog is not initialized');
    }),
  ),
);

it.live('returns the full product shape with derived paragraphs, gallery and variant records', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      const [product] = (yield* catalogPage(fixture, { categorySlug: 'metricke' })).products;
      expect(product?.descriptionParagraphs).toEqual(['První odstavec', 'Druhý odstavec']);
      expect(product?.gallery).toEqual(['/a.jpg', '/b.jpg']);
      expect('variants' in (product ?? {})).toBe(false);
      expect('contentHistory' in (product ?? {})).toBe(false);
      expect(product?.priceHistory).toEqual([]);
      expect(
        product?.variantRecords?.map((variant) => [variant.id, variant.stockOnHand, variant.grossPriceMinor]),
      ).toEqual([['v1', 5, 121]]);
      expect(product?.variantRecords?.[0]?.priceHistory).toEqual([]);
      expect(product?.stockOnHand).toBe(5);
      expect(product?.availability).toBe('IN_STOCK');
    }),
  ),
);

it.live('loads ordered tiers and variant stock without multiplying independent child rows', () => {
  const tiers = [
    { minimumQuantity: 1, priceExcludingVatMinor: 100, priceMinor: 121 },
    { minimumQuantity: 10, priceExcludingVatMinor: 90, priceMinor: 109 },
  ];
  const state = decodeState({
    ...catalogInput,
    products: catalogInput.products.map((product) => {
      const priced = { ...product, priceTiers: tiers };
      if (product.id !== 'p1') {
        return priced;
      }
      return {
        ...priced,
        variants: [
          { attributes: '', id: 'v1', name: 'M8', priceMinor: 100, priceTiers: tiers },
          { attributes: '', id: 'v2', name: 'M10', priceMinor: 200, priceTiers: tiers.slice(0, 1) },
          { attributes: 'informational', name: 'Not sellable' },
        ],
      };
    }),
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* assertIndependentChildren() {
      const page = yield* catalogPage(fixture, { productIds: ['p2', 'p1'] });
      expect(page.products.map((product) => product.id)).toEqual(['p2', 'p1']);
      expect(page.products.map((product) => product.priceTiers)).toEqual([tiers, tiers]);
      const variants = page.products[1]?.variantRecords;
      expect(variants?.map((variant) => [variant.id, variant.stockOnHand])).toEqual([
        ['v1', 5],
        ['v2', 0],
      ]);
      expect(variants?.map((variant) => variant.priceTiers)).toEqual([tiers, tiers.slice(0, 1)]);
      expect(page.products[0]?.variantRecords).toBeUndefined();
    }),
  );
});

it.live('card shape omits variants, description and parameters', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      const [card] = (yield* catalogPage(fixture, { categorySlug: 'metricke', fields: 'card' })).products;
      expect(card?.variantRecords).toBeUndefined();
      expect(card?.description).toBeUndefined();
      expect(card?.parameters).toBeUndefined();
      expect('variants' in (card ?? {})).toBe(false);
      expect('contentHistory' in (card ?? {})).toBe(false);
      expect(card?.grossPriceMinor).toBe(121);
      expect(card?.availability).toBe('IN_STOCK');
    }),
  ),
);

it.live('narrows variant records to the requested cart variants', () =>
  onCatalog((fixture) =>
    Effect.gen(function* () {
      const cart = yield* catalogPage(fixture, { productIds: ['p3', 'p1'], variantIds: ['v1'] });
      expect(cart.products.map((product) => product.id)).toEqual(['p3', 'p1']);
      expect(cart.products[1]?.variantRecords?.map((variant) => variant.id)).toEqual(['v1']);
      const none = yield* catalogPage(fixture, { productIds: ['p1'], variantIds: ['nope'] });
      expect(none.products[0]?.variantRecords).toEqual([]);
    }),
  ),
);

it.live('summarizes active sellable variants on every storefront product', () => {
  const state = decodeState({
    ...catalogInput,
    movements: [
      ...catalogInput.movements,
      {
        at: catalogInput.movements[0]!.at,
        delta: 3,
        id: 'receipt-v2',
        productId: 'p1',
        reason: 'RECEIPT',
        variantId: 'v2',
      },
      {
        at: catalogInput.movements[0]!.at,
        delta: 7,
        id: 'receipt-v3',
        productId: 'p1',
        reason: 'RECEIPT',
        variantId: 'v3',
      },
    ],
    products: catalogInput.products.map((product) =>
      product.id === 'p1'
        ? {
            ...product,
            variants: [
              { attributes: '', id: 'v1', name: 'M8 × 20', priceMinor: 100, sku: 'P1-M8' },
              { attributes: '', id: 'v2', name: 'M10 × 30', priceMinor: 300, sku: 'P1-M10', unit: 'bal' },
              { active: false, attributes: '', id: 'v3', name: 'M6 × 10', priceMinor: 10, sku: 'P1-M6' },
              { attributes: 'pouze informace', name: 'Informační' },
              { attributes: '', id: 'v5', name: 'Bez ceny', sku: 'P1-X', unit: 'm' },
            ],
          }
        : product,
    ),
  });
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* () {
      for (const fields of ['card', 'full'] as const) {
        const page = yield* catalogPage(fixture, { fields, productIds: ['p1', 'p2'] });
        const summaries = Object.fromEntries(page.products.map((product) => [product.id, product.variantSummary]));
        expect(summaries).toEqual({
          p1: { count: 2, minGrossPriceMinor: 121, stockOnHand: 8, units: ['bal', 'ks'] },
          p2: { count: 0, minGrossPriceMinor: null, stockOnHand: 0, units: [] },
        });
      }
    }),
  );
});

it.live('projects order status only for matching storefront id and clientRequestId', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* () {
      expect(yield* storefrontOrderStatus(db, scope, { clientRequestId: 'secret-request-1', orderId: 'o1' })).toEqual({
        id: 'o1',
        number: 'OBJ-2026-0001',
        status: 'NEW',
        statusLabel: 'Nová',
        updatedAt: DateTime.makeUnsafe(catalogInput.orders[0]!.updatedAt),
      });
      expect(
        yield* storefrontOrderStatus(db, scope, { clientRequestId: 'wrong-request-id', orderId: 'o1' }),
      ).toBeNull();
      // Removed DEMO orders are never shown, even with the right secret.
      expect(
        yield* storefrontOrderStatus(db, scope, { clientRequestId: 'secret-request-2', orderId: 'o2' }),
      ).toBeNull();
    }),
  ),
);

it.live('ranks exact/name/SKU matches before descriptions and variant-only matches', () => {
  const state: MerchandiseState = {
    ...catalogState,
    products: catalogState.products.slice(0, 3).map((product, index) => ({
      ...product,
      name: ['BITY', 'Šroub DIN 933/A2', 'DIN 933'][index]!,
      shortDescription: 'DIN 933',
      sku: ['BITY', 'SROUB', 'DIN933'][index]!,
    })),
  };
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* () {
      const byName = yield* catalogPage(fixture, { fields: 'card', q: 'din 933', sort: 'name' });
      expect(byName.products.map((product) => product.name)).toEqual(['DIN 933', 'Šroub DIN 933/A2', 'BITY']);
      const byPrice = yield* catalogPage(fixture, { q: 'din 933', sort: 'price-asc' });
      expect(byPrice.products[0]?.name).toBe('DIN 933');
    }),
  );
});

it.live(
  'prefers photography only within the same search relevance tier, not over exact matches or price sorting',
  () => {
    const template = catalogInput.products[0]!;
    const state = decodeState({
      ...catalogInput,
      homepageFeaturedProductIds: [],
      movements: [],
      orders: [],
      products: [
        { id: 'exact', imageSrc: '/akros/products/image-unavailable.svg', name: 'DIN 933' },
        { id: 'missing', imageSrc: '/akros/products/image-unavailable.svg', name: 'DIN 933 A' },
        { id: 'photo', imageSrc: '/akros/products/sroub.jpg', name: 'Šroub DIN 933' },
        { id: 'gallery', images: ['/akros/products/sroub-b.jpg'], name: 'Šroub DIN 933 B' },
        { id: 'loose', imageSrc: '/akros/products/bity.jpg', name: 'BITY', shortDescription: 'DIN 933' },
      ].map((product, index) => ({
        ...template,
        images: [],
        ...product,
        currentPriceMinor: index + 1,
        sku: product.id,
      })),
    });
    return withMerchandise(state, (fixture) =>
      Effect.gen(function* () {
        const ids = (query: StorefrontCatalogQuery) => idsOf(fixture, query);
        expect(yield* ids({ q: 'DIN 933' })).toEqual(['exact', 'photo', 'gallery', 'missing', 'loose']);
        expect(yield* ids({ q: 'DIN 933', sort: 'name' })).toEqual(['exact', 'photo', 'gallery', 'missing', 'loose']);
        expect(yield* ids({ sort: 'name' })).toEqual(['loose', 'exact', 'missing', 'photo', 'gallery']);
        // Every product's price comes from the same variant, so price order falls back to catalog order.
        expect(yield* ids({ q: 'DIN 933', sort: 'price-asc' })).toEqual([
          'exact',
          'missing',
          'photo',
          'gallery',
          'loose',
        ]);
      }),
    );
  },
);

it.live('sorts and filters by gross price and availability', () => {
  const state: MerchandiseState = {
    ...catalogState,
    products: catalogState.products.filter((product) => product.id !== 'p1'),
  };
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* () {
      expect(yield* idsOf(fixture, { sort: 'price-asc' })).toEqual(['p3', 'p2']);
      expect(yield* idsOf(fixture, { sort: 'price-desc' })).toEqual(['p2', 'p3']);
      expect(yield* idsOf(fixture, { minMinor: 40 })).toEqual(['p2']);
      expect(yield* idsOf(fixture, { maxMinor: 40 })).toEqual(['p3']);
      expect(yield* idsOf(fixture, { availability: 'in-stock' })).toEqual([]);
      expect(yield* idsOf(fixture, { availability: 'out-of-stock' })).toEqual(['p2', 'p3']);
    }),
  );
});

it.live('hides an unpublished category and its descendants from the public navigation only', () => {
  const state: MerchandiseState = {
    ...catalogState,
    categories: catalogState.categories!.map((category) =>
      category.id === 'r' ? { ...category, published: false } : category,
    ),
  };
  return withMerchandise(state, (fixture) =>
    Effect.gen(function* () {
      expect(yield* categoryTree(fixture.db, fixture.scope, { storefront: true })).toEqual([]);
      const staff = yield* categoryTree(fixture.db, fixture.scope, { storefront: false });
      expect(staff.map((category) => [category.id, category.published])).toEqual([
        ['r', false],
        ['c', undefined],
      ]);
      expect((yield* catalogPage(fixture, {})).products.length).toBeGreaterThan(0);
    }),
  );
});

it.live('never reads another company’s rows', () =>
  onCatalog((fixture) =>
    withMerchandise(
      {
        ...catalogState,
        movements: [{ ...catalogState.movements[0]!, delta: 2 }],
        orders: [],
        products: catalogState.products.slice(0, 2),
      },
      (other) =>
        Effect.gen(function* () {
          expect(yield* idsOf(fixture, {})).toEqual(['p1', 'p2', 'p3']);
          expect(yield* idsOf(other, {})).toEqual(['p1', 'p2']);
          expect(
            yield* storefrontOrderStatus(other.db, other.scope, { clientRequestId: 'secret-request-1', orderId: 'o1' }),
          ).toBeNull();
          // Same product and variant ids in both companies: each summary aggregates only its own variant rows.
          const summary = (target: MerchandiseFixture) =>
            catalogPage(target, { fields: 'card', productIds: ['p1'] }).pipe(
              Effect.map((page) => page.products[0]?.variantSummary),
            );
          expect(yield* summary(fixture)).toEqual({ count: 1, minGrossPriceMinor: 121, stockOnHand: 5, units: ['ks'] });
          expect(yield* summary(other)).toEqual({ count: 1, minGrossPriceMinor: 121, stockOnHand: 2, units: ['ks'] });
        }),
    ),
  ),
);

it.live('staff reads page, filter and sort in SQL and indicators cover the whole company', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* () {
      const staffIds = (view: RecordsView, storefront = false) =>
        staffProducts(db, scope, view, storefront).pipe(
          Effect.map((page) => page.products.map((product) => product.id)),
        );
      expect(yield* staffIds({ summary: true })).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(yield* staffIds({ summary: true }, true)).toEqual(['p1', 'p2', 'p3']);
      expect(yield* staffIds({ search: 'sroub', summary: true })).toEqual(['p1']);
      expect(yield* staffIds({ categoryId: 'r', summary: true })).toEqual(['p1', 'p3']);
      expect(yield* staffIds({ lowStockOnly: true, summary: true })).toEqual(['p2', 'p3', 'p4']);
      expect(yield* staffIds({ productSort: 'price-desc', summary: true })).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(yield* staffIds({ productSort: 'price-asc', summary: true })).toEqual(['p4', 'p3', 'p2', 'p1']);
      expect(yield* staffIds({ limit: 2, offset: 1, summary: true })).toEqual(['p2', 'p3']);
      const summary = yield* staffProducts(db, scope, { limit: 1, summary: true }, false);
      expect(summary.total).toBe(4);
      expect(summary.products[0]?.variants).toBeUndefined();
      expect(summary.products[0]?.stockOnHand).toBe(5);
      const detail = yield* staffProducts(db, scope, {}, false);
      expect(detail.products.length).toBe(2);
      expect(detail.products[0]?.variantRecords?.map((variant) => variant.stockOnHand)).toEqual([5]);

      const orderIds = (view: RecordsView) =>
        orderPage(db, scope, view).pipe(Effect.map((page) => [page.total, page.orders.map((order) => order.id)]));
      expect(yield* orderIds({})).toEqual([1, ['o1']]);
      expect(yield* orderIds({ orderSearch: 'OBJ-2026-0001' })).toEqual([1, ['o1']]);
      expect(yield* orderIds({ orderSearch: 'OBJ-2026-0002' })).toEqual([0, []]);
      expect(yield* orderIds({ orderStatus: 'CONFIRMED' })).toEqual([0, []]);

      expect((yield* productMovements(db, scope, 'p1')).map((movement) => movement.id)).toEqual(['receipt']);
      expect(yield* productMovements(db, scope, 'p2')).toEqual([]);

      expect(yield* indicators(db, scope)).toEqual({
        lowStockCount: 3,
        openOrderValueMinor: 100,
        orderCount: 1,
        productCount: 4,
        stockValueMinor: 500,
      });
    }),
  ),
);

it.live('staff list filters by tagged ids and product category label across pages, with grouped variant counts', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* staffTagAndCategoryFilters() {
      const page = (view: RecordsView) =>
        staffProducts(db, scope, { summary: true, ...view }, false).pipe(
          Effect.map((result) => [result.total, result.products.map((product) => product.id)]),
        );
      expect(yield* page({ taggedProductIds: ['p2', 'p4', 'unknown'] })).toEqual([2, ['p2', 'p4']]);
      expect(yield* page({ limit: 1, offset: 1, taggedProductIds: ['p2', 'p4'] })).toEqual([2, ['p4']]);
      expect(yield* page({ taggedProductIds: [] })).toEqual([0, []]);
      expect(yield* page({ category: 'Šrouby', taggedProductIds: ['p1', 'p2'] })).toEqual([1, ['p1']]);
      expect(yield* productCategoryCounts(db, scope)).toEqual([
        { name: 'Matice', productCount: 1 },
        { name: 'Podložky', productCount: 1 },
        { name: 'Šrouby', productCount: 2 },
      ]);
      const rows = yield* staffProducts(db, scope, { summary: true }, false);
      expect(rows.products.map((product) => [product.id, product.variantCount])).toEqual([
        ['p1', 1],
        ['p2', 0],
        ['p3', 0],
        ['p4', 0],
      ]);
    }),
  ),
);

it.live('order search matches customers resolved from the register and the tag filter narrows the total', () =>
  onCatalog(({ db, scope }) =>
    Effect.gen(function* orderCustomerSearch() {
      const orderIds = (view: RecordsView) =>
        orderPage(db, scope, view).pipe(Effect.map((result) => [result.total, result.orders.map((order) => order.id)]));
      expect(yield* orderIds({ orderSearch: 'novák' })).toEqual([0, []]);
      expect(yield* orderIds({ orderCustomerPartyIds: ['storefront-guest'], orderSearch: 'novák' })).toEqual([
        1,
        ['o1'],
      ]);
      expect(yield* orderIds({ orderCustomerPartyIds: ['someone-else'], orderSearch: 'novák' })).toEqual([0, []]);
      expect(yield* orderIds({ orderCustomerPartyIds: ['someone-else'], orderSearch: '0001' })).toEqual([1, ['o1']]);
      expect(yield* orderIds({ taggedOrderIds: ['o1'] })).toEqual([1, ['o1']]);
      expect(yield* orderIds({ taggedOrderIds: ['o2'] })).toEqual([0, []]);
    }),
  ),
);

it.live('in-app AKROS reset writes the bundled baseline part by part and advances the revision', () =>
  onCatalog(({ db, revision, scope }) =>
    Effect.gen(function* akrosReset() {
      const next = yield* db.transaction((transaction) => resetToAkrosBaseline(transaction, scope));
      expect(next).toBe(revision + 1);
      const totals = yield* indicators(db, scope);
      expect(totals.productCount).toBe(1289);
      expect(totals.orderCount).toBe(6);
      const head = yield* loadHead(db, scope);
      expect(head?.homepageFeaturedProductIds.length).toBeGreaterThan(0);
      expect((yield* staffProducts(db, scope, { productIds: ['p1'], summary: true }, false)).total).toBe(0);
    }),
  ),
);

it.live(
  'customer orders filter by verified subject in SQL, isolate detail and paginate without exposing guests or removed orders',
  () => {
    const original = catalogInput.orders[0]!;
    const state = decodeState({
      ...catalogInput,
      orders: [
        ...Array.from({ length: 51 }, (_, index) => ({
          ...original,
          id: `customer-order-${index}`,
          number: `OBJ-TEST-${index}`,
          customerAccountId: 'customer-one',
          clientRequestId: `customer-submission-${index}`,
        })),
        {
          ...original,
          id: 'other-customer',
          number: 'OTHER-CUSTOMER',
          clientRequestId: 'other-submission',
          customerAccountId: 'customer-two',
        },
        { ...original, id: 'guest-order', number: 'GUEST-ORDER', clientRequestId: 'guest-submission' },
        {
          ...original,
          id: 'staff-order',
          number: 'STAFF-ORDER',
          clientRequestId: 'staff-submission',
          channel: 'STAFF',
          customerAccountId: 'customer-one',
        },
        { ...catalogInput.orders[1]!, id: 'removed-order', customerAccountId: 'customer-one' },
      ],
    });
    return withMerchandise(state, ({ db, scope }) =>
      Effect.gen(function* () {
        const first = yield* storefrontCustomerOrders(db, scope, { customerAccountId: 'customer-one' });
        expect(first.total).toBe(51);
        expect(first.orders).toHaveLength(50);
        expect(first.orders.every((order) => order.customerAccountId === 'customer-one')).toBe(true);
        const second = yield* storefrontCustomerOrders(db, scope, { customerAccountId: 'customer-one', offset: 50 });
        expect(second.orders).toHaveLength(1);
        expect(first.orders.some((order) => order.id === second.orders[0]!.id)).toBe(false);
        expect(
          (yield* storefrontCustomerOrders(db, scope, {
            customerAccountId: 'customer-one',
            orderId: 'customer-order-0',
          })).orders[0]?.lines,
        ).toEqual(original.lines);
        for (const orderId of ['other-customer', 'guest-order', 'staff-order', 'removed-order']) {
          expect(
            (yield* storefrontCustomerOrders(db, scope, { customerAccountId: 'customer-one', orderId })).orders,
          ).toEqual([]);
        }
        expect(
          (yield* storefrontCustomerOrders(
            db,
            { ...scope, tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
            { customerAccountId: 'customer-one' },
          )).orders,
        ).toEqual([]);
      }),
    );
  },
);
