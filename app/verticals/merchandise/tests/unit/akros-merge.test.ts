import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  backfillProduct,
  decodeCategoryText,
  decodeHtmlEntities,
  mergeSeed,
  orderCategoryPositions,
  stripUnbackedDiscount,
} from '../../scripts/akros-merge.ts';
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

it('decodes the HTML entities found in the AKROS source copy and leaves unknown ones', () => {
  expect(
    decodeHtmlEntities(
      'dílů &ndash; nerez &bdquo;A2&ldquo; 90&deg; M6 &times; 20&hellip; &quot;x&quot; &gt; &#8211; &foo;',
    ),
  ).toBe('dílů – nerez „A2“ 90° M6 × 20… "x" > – &foo;');
});

it('cleans entities in existing category text once and is then idempotent', () => {
  const dirty = { ...category('c1'), description: 'Kartáče &ndash; nerez', longDescription: '<p>90&deg;</p>' };
  const once = mergeSeed(state({ categories: [dirty] }), state({ categories: [category('c1')] }));
  expect(once.categories?.[0]?.description).toBe('Kartáče – nerez');
  expect(once.categories?.[0]?.longDescription).toBe('<p>90°</p>');
  expect(once.categories?.[0]?.name).toBe('Kategorie c1');
  const twice = mergeSeed(once, state({ categories: [category('c1')] }));
  expect(twice.categories?.[0]).toBe(once.categories?.[0]);
});

it('removes the quantity-discount promise no price tier backs and keeps the rest of the text', () => {
  expect(
    stripUnbackedDiscount(
      'Limity množstevních slev: nižší cena od 100 kusů další snížení ceny od 500 kusů Snížená cena se projeví po vložení zboží do košíku Odolnost: 140 stupňů',
    ),
  ).toBe('Odolnost: 140 stupňů');
  expect(
    stripUnbackedDiscount(
      'Limity množstevních slevy nižší cena od 100 kusů Snížená cena se projeví po vložení zboží do košíku.',
    ),
  ).toBe('');
  expect(stripUnbackedDiscount('Nerezový šroub')).toBe('Nerezový šroub');
});

it('numbers unordered siblings 10, 20, 30 by Czech name and keeps a group staff already ordered', () => {
  const ordered = orderCategoryPositions([
    { name: 'Šrouby', parentId: null, position: 0 },
    { name: 'Matice', parentId: null, position: 0 },
    { name: 'Čepy', parentId: null, position: 0 },
    { name: 'B', parentId: 'x', position: 5 },
    { name: 'A', parentId: 'x', position: 0 },
  ]);
  expect(ordered.map((category) => `${category.name}:${category.position}`)).toEqual([
    'Šrouby:30',
    'Matice:20',
    'Čepy:10',
    'B:5',
    'A:0',
  ]);
});

it('stores the source "NULL" description placeholder as empty text', () => {
  expect(
    decodeCategoryText({ name: 'Null', description: 'NULL', longDescription: ' null ', heading: 'Šrouby' }),
  ).toEqual({
    name: 'Null',
    description: '',
    longDescription: '',
    heading: 'Šrouby',
  });
});

it('normalizes stainless grade labels at the owner import source without changing category identities', () => {
  expect(decodeCategoryText({ heading: 'DIN 933 – A 2', imageAlt: 'A 5', name: 'A 4', slug: 'a-4' })).toEqual({
    heading: 'DIN 933 – A2',
    imageAlt: 'A5',
    name: 'A4',
    slug: 'a-4',
  });
});
