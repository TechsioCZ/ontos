import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyProductsReadQuerySchema } from '../../api/symmy/contract.ts';
import {
  mapSymmyProductsProjection,
  selectSymmyProductFields,
  SymmyProductsResponseSchema,
  SymmyProductsSelectedResponseSchema,
} from '../../api/symmy/products-public-contract.ts';
import { SymmyInternalProductsProjectionSchema } from '../../api/symmy/read-projection-contracts.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const at = '1970-01-01T00:00:00.000Z';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const readId = (letter: string) => `~c14r1.${letter.repeat(43)}`;
const nativeProduct = (extra: { readonly description?: string; readonly name?: string }) => ({
  catalogReady: false,
  createdAt: at,
  lifecycle: 'DRAFT',
  productRef,
  revision: 1,
  updatedAt: at,
  variants: [{ lifecycle: 'WORK_IN_PROGRESS', productRef, variantId, variantRef }],
  ...extra,
});
const projection = () =>
  Schema.decodeUnknownSync(SymmyInternalProductsProjectionSchema)({
    contractVersion: 'INTERNAL_C14',
    count: 3,
    limit: 50,
    offset: 1,
    products: [
      {
        id: readId('a'),
        product: nativeProduct({ description: 'About', name: 'Named' }),
        source_record_id: 'source-product-a',
        variantSources: [{ id: readId('b'), source_record_id: 'source-variant-a', variantId }],
      },
      {
        id: readId('c'),
        product: nativeProduct({}),
        source_record_id: 'source-product-b',
        variantSources: [],
      },
    ],
    projection: 'products',
    unsupported_fields: ['tax', 'assortment', 'prices', 'stock'],
  });
const decodeQuery = Schema.decodeUnknownResult(SymmyProductsReadQuerySchema);

describe('Symmy public products body', () => {
  it('maps the internal projection to camelCase without markers, cursor or unsupported fields', () => {
    const body = mapSymmyProductsProjection(projection());
    expect(body.count).toBe(3);
    expect(body.offset).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.products[0]).toMatchObject({
      id: readId('a'),
      sourceRecordId: 'source-product-a',
      variantSources: [{ id: readId('b'), sourceRecordId: 'source-variant-a', variantId }],
    });
    expect(body.products[0]?.product).toMatchObject({ description: 'About', name: 'Named', productRef });
    expect(Schema.is(Schema.toType(SymmyProductsResponseSchema))(body)).toBe(true);
    for (const forbidden of [
      'contractVersion',
      'projection',
      'unsupported_fields',
      'unsupportedFields',
      'nextRecordId',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    for (const item of body.products) {
      expect(item).not.toHaveProperty('source_record_id');
      expect(JSON.stringify(item)).not.toContain('source_record_id');
      expect(JSON.stringify(item)).not.toContain('null');
    }
  });

  it('keeps an absent name and description absent instead of null', () => {
    const product = mapSymmyProductsProjection(projection()).products[1]?.product;
    expect(product).not.toHaveProperty('name');
    expect(product).not.toHaveProperty('description');
  });

  it('maps an empty page', () => {
    expect(mapSymmyProductsProjection({ ...projection(), count: 0, offset: 0, products: [] })).toEqual({
      count: 0,
      limit: 50,
      offset: 0,
      products: [],
    });
  });

  it('keeps only id and the selected item keys, and the envelope', () => {
    const full = mapSymmyProductsProjection(projection());
    const selected = selectSymmyProductFields(full, ['sourceRecordId', 'sourceRecordId']);
    expect(selected).toEqual({
      count: 3,
      limit: 50,
      offset: 1,
      products: [
        { id: readId('a'), sourceRecordId: 'source-product-a' },
        { id: readId('c'), sourceRecordId: 'source-product-b' },
      ],
    });
    expect(Schema.is(Schema.toType(SymmyProductsSelectedResponseSchema))(selected)).toBe(true);
    expect(selectSymmyProductFields(full, ['variantSources']).products[0]).toEqual({
      id: readId('a'),
      variantSources: full.products[0]?.variantSources,
    });
  });

  it('selects product paths into a product with only those keys', () => {
    const full = mapSymmyProductsProjection(projection());
    const selected = selectSymmyProductFields(full, ['product.name', 'variantSources']);
    expect(selected.products[0]).toEqual({
      id: readId('a'),
      product: { name: 'Named' },
      variantSources: full.products[0]?.variantSources,
    });
    expect(selectSymmyProductFields(full, ['product.lifecycle', 'product.revision']).products[0]?.product).toEqual({
      lifecycle: 'DRAFT',
      revision: 1,
    });
  });

  it('leaves a selected optional key absent when the product has none', () => {
    const selected = selectSymmyProductFields(mapSymmyProductsProjection(projection()), [
      'product.name',
      'product.description',
    ]);
    expect(selected.products[1]).toEqual({ id: readId('c'), product: {} });
    expect(JSON.stringify(selected)).not.toContain('null');
  });

  it('returns the whole product when it is named with one of its paths', () => {
    const full = mapSymmyProductsProjection(projection());
    expect(selectSymmyProductFields(full, ['product.name', 'product']).products[0]).toEqual({
      id: readId('a'),
      product: full.products[0]?.product,
    });
    expect(selectSymmyProductFields(full, ['product']).products[1]).toEqual({
      id: readId('c'),
      product: full.products[1]?.product,
    });
  });

  it('returns the full body when every path is selected', () => {
    const full = mapSymmyProductsProjection(projection());
    expect(selectSymmyProductFields(full, ['sourceRecordId', 'product', 'variantSources'])).toEqual(full);
  });
});

describe('Symmy products query', () => {
  const paths = [
    'sourceRecordId',
    'product',
    'product.productRef',
    'product.revision',
    'product.lifecycle',
    'product.catalogReady',
    'product.name',
    'product.description',
    'product.createdAt',
    'product.updatedAt',
    'product.variants',
    'variantSources',
  ];
  const accepted = [
    {},
    { limit: '1' },
    { limit: '100', offset: '0' },
    { q: 'chair' },
    { q: '  chair  ' },
    { q: '%' },
    { q: 'a'.repeat(200) },
    ...paths.map((fields) => ({ fields })),
    { fields: paths.join(',') },
    { fields: 'product.name,product.name' },
    { fields: 'sourceRecordId', limit: '2', offset: '1', q: 'a' },
  ];
  for (const query of accepted) {
    it(`accepts ${JSON.stringify(query).slice(0, 60)}`, () => {
      expect(Result.isSuccess(decodeQuery(query))).toBe(true);
    });
  }

  const rejected = [
    { limit: '0' },
    { limit: '101' },
    { limit: 'abc' },
    { offset: '-1' },
    { offset: 'abc' },
    { q: '' },
    { q: '   ' },
    { q: 'a'.repeat(201) },
    { fields: '' },
    { fields: 'nope' },
    { fields: 'id' },
    { fields: 'product.name,' },
    { fields: ',product.name' },
    { fields: 'product.name,,sourceRecordId' },
    { fields: '+product.name' },
    { fields: '-product.name' },
    { fields: 'product.name, sourceRecordId' },
    { fields: ' product.name' },
    { fields: 'Product.name' },
    { fields: 'variantSources.id' },
    { fields: 'product.variants.variantId' },
    { fields: 'product.productRef.tenantId' },
    { fields: 'x'.repeat(501) },
    { afterRecordId: 'cursor' },
    { code: 'source' },
    { sourceRecordId: 'source' },
    { contractVersion: 'INTERNAL_C14' },
    { priceLimit: '1' },
    { priceOffset: '1' },
    { order: 'name' },
    { sales_channel_id: 'sc' },
    { price_list_id: 'pl' },
    { status: 'ACTIVE' },
    { 'created_at[$gte]': '2026-01-01' },
    { unknown: '1' },
  ];
  for (const query of rejected) {
    it(`rejects ${JSON.stringify(query).slice(0, 60)}`, () => {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(SymmyProductsReadQuerySchema)(query, { onExcessProperty: 'error' }),
        ),
      ).toBe(true);
    });
  }

  it('trims q and splits fields into names', () => {
    const decoded = Schema.decodeUnknownSync(SymmyProductsReadQuerySchema)({
      fields: 'product.name,sourceRecordId',
      q: '  chair ',
    });
    expect(decoded).toEqual({ fields: ['product.name', 'sourceRecordId'], q: 'chair' });
  });
});
