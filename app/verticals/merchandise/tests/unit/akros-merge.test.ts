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
import { OrderSchema } from '../../shared/domain/merchandise-model.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';

const at = '2026-10-19T08:00:00.000Z';
type EncodedState = typeof MerchandiseStateSchema.Encoded;
type EncodedProduct = EncodedState['products'][number];
type EncodedVariant = NonNullable<EncodedProduct['variants']>[number];
const product = (id: string, overrides: Partial<EncodedProduct> = {}): EncodedProduct => ({
  active: true,
  category: 'Šrouby',
  createdAt: at,
  currentPriceMinor: 8,
  id,
  lowStockThreshold: 5,
  name: `Produkt ${id}`,
  priceHistory: [],
  sku: `SKU-${id}`,
  unit: 'ks',
  updatedAt: at,
  vatRate: 21,
  ...overrides,
});
const variant = (overrides: Partial<EncodedVariant> = {}): EncodedVariant => ({
  active: true,
  attributes: '',
  id: 'v1',
  minimumQuantity: 10,
  name: 'M6 × 20',
  priceMinor: 8,
  priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: 8, priceMinor: 10 }],
  sku: 'SKU-v1',
  sourceId: '1',
  sourceUnit: 'ks',
  ...overrides,
});
const category = (id: string) => ({
  description: '',
  hasChildren: false,
  heading: `Kategorie ${id}`,
  id,
  imageAlt: `Kategorie ${id}`,
  imageSrc: '',
  longDescription: '',
  name: `Kategorie ${id}`,
  parentId: null,
  position: 0,
  slug: id,
});
const movement = (id: string, productId: string): EncodedState['movements'][number] => ({
  at,
  delta: 5,
  id,
  productId,
  reason: 'RECEIPT',
});
const state = (input: Partial<EncodedState>): MerchandiseState =>
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
  const current = state({ products: [product('p1', { currentPriceMinor: 99, name: 'Vlastní název' })] });
  const seed = state({ products: [product('p1', { imageAlt: 'Alt ze semene', imageSrc: '/img.jpg' })] });
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
  expect(backfillProduct(current.products[0], seed.products[0]).variants?.[0]?.isSale).toEqual(true);
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
    movements: [movement('m-extra', 'p-extra')],
    products: [product('p-extra'), product('p1', { variants: [variant()] })],
  });
  const seed = state({
    categories: [category('c1')],
    movements: [movement('m1', 'p1')],
    products: [product('p1', { imageAlt: 'Alt', variants: [variant({ isSale: true })] }), product('p2')],
  });
  const once = mergeSeed(current, seed);
  expect(mergeSeed(once, seed)).toEqual(once);
});

it('keeps existing orders and movements and skips seed records already present', () => {
  const order = Schema.decodeUnknownSync(OrderSchema)({
    createdAt: at,
    id: 'o1',
    lines: [{ productId: 'p1', productName: 'Produkt p1', quantity: 1, sku: 'SKU-p1', unitPriceMinor: 8, vatRate: 21 }],
    number: 'OBJ-2026-0001',
    partyId: 'party-1',
    status: 'NEW',
    totalMinor: 10,
    totalVatMinor: 2,
    updatedAt: at,
  });
  const seedOrder = Schema.decodeUnknownSync(OrderSchema)({
    ...Schema.encodeSync(OrderSchema)(order),
    id: 'o-seed',
  });
  const current = {
    ...state({ movements: [movement('m1', 'p1')], products: [product('p1')] }),
    orders: [order],
  };
  const seed = {
    ...state({ movements: [movement('m1', 'p1'), movement('m2', 'p1')], products: [product('p1')] }),
    orders: [seedOrder],
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
  expect(ordered.map((entry) => `${entry.name}:${entry.position}`)).toEqual([
    'Šrouby:30',
    'Matice:20',
    'Čepy:10',
    'B:5',
    'A:0',
  ]);
});

it('stores the source "NULL" description placeholder as empty text', () => {
  expect(
    decodeCategoryText({ description: 'NULL', heading: 'Šrouby', longDescription: ' null ', name: 'Null' }),
  ).toEqual({
    description: '',
    heading: 'Šrouby',
    longDescription: '',
    name: 'Null',
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
