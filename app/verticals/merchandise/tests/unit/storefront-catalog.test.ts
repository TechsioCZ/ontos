import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseStateSchema, type StorefrontCatalogQuery } from '../../shared/apis/records.ts';
import {
  storefrontCatalogPage,
  storefrontOrderStatusOf,
  toStorefrontProduct,
} from '../../src/services/storefront-catalog.ts';
import { toProductRecord } from '../../src/services/persistence.service.ts';

const at = '2026-10-19T08:00:00.000Z';
const base = {
  active: true,
  unit: 'ks',
  vatRate: 21,
  lowStockThreshold: 0,
  createdAt: at,
  updatedAt: at,
  priceHistory: [],
};
const state = Schema.decodeUnknownSync(MerchandiseStateSchema)({
  categories: [
    {
      id: 'r',
      parentId: null,
      name: 'Šrouby',
      slug: 'srouby',
      heading: 'Šrouby',
      description: 'Krátký popis',
      longDescription: 'Dlouhý popis kořene',
      position: 0,
      imageSrc: '',
      imageAlt: 'Šrouby',
      hasChildren: true,
      history: [],
    },
    {
      id: 'c',
      parentId: 'r',
      name: 'Metrické',
      slug: 'metricke',
      heading: 'Metrické',
      description: '',
      longDescription: 'Dlouhý popis',
      position: 1,
      imageSrc: '',
      imageAlt: 'Metrické',
      hasChildren: false,
      history: [],
    },
  ],
  homepageFeaturedProductIds: ['p3'],
  movements: [{ id: 'receipt', productId: 'p1', variantId: 'v1', delta: 5, at, reason: 'RECEIPT' }],
  orders: [
    {
      id: 'o1',
      clientRequestId: 'secret-request-1',
      channel: 'STOREFRONT',
      number: 'OBJ-2026-0001',
      status: 'NEW',
      partyId: 'storefront-guest',
      lines: [{ productId: 'p1', productName: 'P1', quantity: 1, sku: 'P1', unitPriceMinor: 100, vatRate: 21 }],
      totalMinor: 100,
      totalVatMinor: 17,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'o2',
      clientRequestId: 'secret-request-2',
      channel: 'STOREFRONT',
      number: 'OBJ-2026-0002',
      status: 'NEW',
      partyId: 'storefront-guest',
      lines: [{ productId: 'p1', productName: 'P1', quantity: 1, sku: 'P1', unitPriceMinor: 100, vatRate: 21 }],
      totalMinor: 100,
      totalVatMinor: 17,
      createdAt: at,
      updatedAt: at,
      demoCleanup: {
        at,
        actor: {
          principalId: '20000000-0000-4000-8000-000000000002',
          tenantId: '20000000-0000-4000-8000-000000000001',
        },
        reason: 'Ukázka skončila',
      },
    },
  ],
  products: [
    {
      ...base,
      id: 'p1',
      name: 'Šroub zinkovaný',
      sku: 'P1',
      category: 'Šrouby',
      currentPriceMinor: 100,
      categoryId: 'c',
      categoryPathIds: ['c', 'r'],
      isRecommended: true,
      description: 'První odstavec\n\nDruhý odstavec',
      images: ['/a.jpg', '/b.jpg'],
      parameters: [{ label: 'Materiál', value: 'nerez A2', unit: '' }],
      variants: [{ id: 'v1', name: 'M8 × 20', sku: 'P1-M8', attributes: '', priceMinor: 100 }],
    },
    {
      ...base,
      id: 'p2',
      name: 'Podložka',
      sku: 'P2',
      category: 'Podložky',
      currentPriceMinor: 50,
      categoryId: 'x',
      isSale: true,
    },
    {
      ...base,
      id: 'p3',
      name: 'Matice',
      sku: 'P3',
      category: 'Matice',
      currentPriceMinor: 30,
      categoryId: 'r',
      categoryPathIds: ['r'],
    },
    {
      ...base,
      id: 'p4',
      name: 'Skrytý výrobek',
      sku: 'P4',
      category: 'Šrouby',
      currentPriceMinor: 10,
      published: false,
    },
  ],
});
const records = state.products.map((product) => toProductRecord(product, state.movements));
const page = (query: StorefrontCatalogQuery) => storefrontCatalogPage({ state, records, query });
const ids = (query: StorefrontCatalogQuery) => page(query).products.map((product) => product.id);

it('hides unpublished products and returns categories without history by default', () => {
  const result = page({});
  expect(result.total).toBe(3);
  expect(result.categories?.length).toBe(2);
  expect(result.categories?.every((category) => !('history' in category))).toBe(true);
});

it('filters by category slug including descendants through categoryPathIds', () => {
  expect(ids({ categorySlug: 'srouby' })).toEqual(['p1', 'p3']);
  expect(ids({ categorySlug: 'metricke' })).toEqual(['p1']);
  expect(page({ categorySlug: 'neexistuje' }).total).toBe(0);
});

it('lists featured products in homepage order followed by recommended ones', () => {
  expect(ids({ featured: true })).toEqual(['p3', 'p1']);
});

it('filters by label', () => {
  expect(ids({ label: 'sale' })).toEqual(['p2']);
});

it('searches name, sku and variant text case-insensitively', () => {
  expect(ids({ q: 'm8' })).toEqual(['p1']);
});

it('ignores diacritics and word order and searches parameters like the mock search', () => {
  expect(ids({ q: 'sroub' })).toEqual(['p1']);
  expect(ids({ q: 'ŠROUB' })).toEqual(['p1']);
  expect(ids({ q: 'zinkovany sroub' })).toEqual(['p1']);
  expect(ids({ q: 'nerez a2' })).toEqual(['p1']);
  expect(ids({ q: 'sroub neexistuje' })).toEqual([]);
});

it('sends heading and long description only for the requested category', () => {
  const categories = page({ categorySlug: 'metricke' }).categories ?? [];
  expect(categories.find((category) => category.id === 'c')?.longDescription).toBe('Dlouhý popis');
  expect(categories.find((category) => category.id === 'r')?.longDescription).toBe('');
  expect(categories.find((category) => category.id === 'r')?.description).toBe('Krátký popis');
});

it('pages results while keeping the total', () => {
  const result = page({ pageSize: 2, page: 2 });
  expect(result.products.length).toBe(1);
  expect(result.total).toBe(3);
});

it('returns full product shape with derived paragraphs and gallery', () => {
  const [product] = page({ slug: undefined, categorySlug: 'metricke' }).products;
  expect(product?.descriptionParagraphs).toEqual(['První odstavec', 'Druhý odstavec']);
  expect(product?.gallery).toEqual(['/a.jpg', '/b.jpg']);
  expect('variants' in (product ?? {})).toBe(false);
  expect(product?.variantRecords?.[0]?.priceHistory).toEqual([]);
});

it('card shape omits variants and description', () => {
  const [product] = page({ categorySlug: 'metricke', fields: 'card' }).products;
  expect(product?.variantRecords).toBeUndefined();
  expect(product?.description).toBeUndefined();
});

it('omits categories when includeCategories is false', () => {
  expect(page({ includeCategories: false }).categories).toBeUndefined();
});

it('projects order status only for matching storefront id and clientRequestId', () => {
  expect(storefrontOrderStatusOf(state.orders, { orderId: 'o1', clientRequestId: 'secret-request-1' })).toEqual({
    id: 'o1',
    number: 'OBJ-2026-0001',
    status: 'NEW',
    statusLabel: 'Nová',
    updatedAt: state.orders[0]!.updatedAt,
  });
  expect(storefrontOrderStatusOf(state.orders, { orderId: 'o1', clientRequestId: 'wrong-request-id' })).toBeNull();
  expect(storefrontOrderStatusOf(state.orders, { orderId: 'o2', clientRequestId: 'secret-request-2' })).toBeNull();
});

it('keeps the card projection free of raw variants', () => {
  const card = toStorefrontProduct(records[0]!, 'card');
  expect('variants' in card).toBe(false);
  expect('contentHistory' in card).toBe(false);
});
