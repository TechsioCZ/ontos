import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { backfillProduct, mergeSeed } from '../../scripts/akros-merge.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';

const at = '2026-10-19T08:00:00.000Z';
const product = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Produkt ${id}`,
  sku: `SKU-${id}`,
  category: 'Šrouby',
  active: true,
  unit: 'ks',
  vatRate: 21,
  currentPriceMinor: 8,
  lowStockThreshold: 5,
  createdAt: at,
  updatedAt: at,
  priceHistory: [],
  ...overrides,
});
const variant = (overrides: Record<string, unknown> = {}) => ({
  id: 'v1',
  sourceId: '1',
  sourceUnit: 'ks',
  sku: 'SKU-v1',
  name: 'M6 × 20',
  attributes: '',
  active: true,
  priceMinor: 8,
  minimumQuantity: 10,
  priceTiers: [{ minimumQuantity: 1, priceMinor: 10, priceExcludingVatMinor: 8 }],
  ...overrides,
});
const category = (id: string) => ({
  id,
  parentId: null,
  name: `Kategorie ${id}`,
  slug: id,
  heading: `Kategorie ${id}`,
  description: '',
  longDescription: '',
  position: 0,
  imageSrc: '',
  imageAlt: `Kategorie ${id}`,
  hasChildren: false,
});
const movement = (id: string, productId: string) => ({ id, productId, at, delta: 5, reason: 'RECEIPT' });
const state = (input: Record<string, unknown>): MerchandiseState =>
  Schema.decodeUnknownSync(MerchandiseStateSchema)({
    categories: [],
    homepageFeaturedProductIds: [],
    movements: [],
    orders: [],
    products: [],
    ...input,
  });

it('orders seed products first and appends current-only products last', () => {
  const current = state({ products: [product('p-extra'), product('p2')] });
  const seed = state({ products: [product('p1'), product('p2')] });
  expect(mergeSeed(current, seed).products.map((entry) => entry.id)).toEqual(['p1', 'p2', 'p-extra']);
});

it('keeps current price and name, fills only missing imageAlt', () => {
  const current = state({ products: [product('p1', { name: 'Vlastní název', currentPriceMinor: 99 })] });
  const seed = state({ products: [product('p1', { imageSrc: '/img.jpg', imageAlt: 'Alt ze semene' })] });
  const [merged] = mergeSeed(current, seed).products;
  expect(merged?.name).toEqual('Vlastní název');
  expect(merged?.currentPriceMinor).toEqual(99);
  expect(merged?.imageSrc).toEqual('/img.jpg');
  expect(merged?.imageAlt).toEqual('Alt ze semene');
});

it('does not overwrite an existing non-empty imageAlt', () => {
  const current = state({ products: [product('p1', { imageAlt: 'Vlastní alt' })] });
  const seed = state({ products: [product('p1', { imageAlt: 'Alt ze semene' })] });
  expect(mergeSeed(current, seed).products[0]?.imageAlt).toEqual('Vlastní alt');
});

it('fills a missing isSale flag on an existing variant from the seed', () => {
  const current = state({ products: [product('p1', { variants: [variant()] })] });
  const seed = state({ products: [product('p1', { variants: [variant({ isSale: true })] })] });
  expect(backfillProduct(current.products[0]!, seed.products[0]!).variants?.[0]?.isSale).toEqual(true);
});

it('adds seed categories once across repeated merges', () => {
  const current = state({ categories: [category('c0')] });
  const seed = state({ categories: [category('c0'), category('c1')] });
  const once = mergeSeed(current, seed);
  expect(once.categories?.map((entry) => entry.id)).toEqual(['c0', 'c1']);
  expect(mergeSeed(once, seed).categories?.map((entry) => entry.id)).toEqual(['c0', 'c1']);
});

it('is idempotent when applied twice', () => {
  const current = state({
    products: [product('p-extra'), product('p1', { variants: [variant()] })],
    movements: [movement('m-extra', 'p-extra')],
  });
  const seed = state({
    categories: [category('c1')],
    movements: [movement('m1', 'p1')],
    products: [product('p1', { variants: [variant({ isSale: true })], imageAlt: 'Alt' }), product('p2')],
  });
  const once = mergeSeed(current, seed);
  expect(mergeSeed(once, seed)).toEqual(once);
});

it('keeps existing orders and movements and skips seed records already present', () => {
  const order = { id: 'o1', number: 'OBJ-2026-0001' };
  const seedOrder = { id: 'o-seed', number: 'OBJ-2026-0001' };
  const current = {
    ...state({ movements: [movement('m1', 'p1')], products: [product('p1')] }),
    orders: [order as unknown as MerchandiseState['orders'][number]],
  };
  const seed = {
    ...state({ movements: [movement('m1', 'p1'), movement('m2', 'p1')], products: [product('p1')] }),
    orders: [seedOrder as unknown as MerchandiseState['orders'][number]],
  };
  const merged = mergeSeed(current, seed);
  expect(merged.orders.map((entry) => entry.id)).toEqual(['o1']);
  expect(merged.movements.map((entry) => entry.id)).toEqual(['m1', 'm2']);
});
