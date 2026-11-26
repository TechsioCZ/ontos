import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyProductsBatchRequestSchema } from '../../api/symmy/products-batch-request-contract.ts';
import { priceGroupId, productId, productRef, unitId, variantId } from './symmy-price-requests.fixtures.ts';
import type { Json } from './symmy-price-requests.fixtures.ts';

// The HTTP layer decodes with excess properties rejected; the schema must hold under the same options.
const accepts = (body: Json) =>
  Result.isSuccess(Schema.decodeUnknownResult(SymmyProductsBatchRequestSchema, { onExcessProperty: 'error' })(body));
const uuid = (suffix: string) => `66666666-6666-4666-8666-${suffix.padStart(12, '0')}`;
const categoryIds = (count: number) => Array.from({ length: count }, (_, index) => uuid(`${index}`));
const variant = { identifier: { type: 'sku', value: 'SKU-1-A' } };
const product = { name: 'Product', variants: [variant] };
const withProduct = (extra: Readonly<Record<string, Json>>) => ({ products: [{ ...product, ...extra }] });
const withVariant = (extra: Readonly<Record<string, Json>>) => withProduct({ variants: [{ ...variant, ...extra }] });
const price = { amount: '10.5', currencyCode: 'CZK' };
const texts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ locale: `en-x-fixture-${index}`, name: 'N' }));
const channel = (channelId: string) => withVariant({ prices: [{ ...price, commercialScope: { channelId } }] });

describe('Symmy products batch request: products', () => {
  it('accepts the minimal product and a full product', () => {
    expect(accepts({ products: [product] })).toBe(true);
    expect(
      accepts(
        withProduct({
          categoryIds: [uuid('1')],
          description: 'Long text',
          gtin: { code: '8590000000011', effectiveAt: '2026-01-01T00:00:00Z' },
          identifier: { type: 'erpId', value: 'erp-1' },
          lifecycle: 'ACTIVE',
          localized: [{ description: 'Popis', locale: 'cs-CZ', name: 'Produkt' }],
          productTypeId: uuid('2'),
          sku: 'SKU-1',
        }),
      ),
    ).toBe(true);
  });

  it('limits the request to one to sixteen products', () => {
    expect(accepts({ products: Array.from({ length: 16 }, () => product) })).toBe(true);
    expect(accepts({ products: Array.from({ length: 17 }, () => product) })).toBe(false);
    expect(accepts({ products: [] })).toBe(false);
    expect(accepts({})).toBe(false);
  });

  it('requires a name and at least one variant', () => {
    expect(accepts({ products: [{ variants: [variant] }] })).toBe(false);
    expect(accepts({ products: [{ name: 'P' }] })).toBe(false);
    expect(accepts({ products: [{ name: 'P', variants: [] }] })).toBe(false);
    expect(accepts(withProduct({ name: '' }))).toBe(false);
    expect(accepts(withProduct({ name: 'n'.repeat(241) }))).toBe(false);
    expect(accepts(withProduct({ name: 'n'.repeat(240) }))).toBe(true);
    expect(accepts(withProduct({ description: 'd'.repeat(4001) }))).toBe(false);
    expect(accepts(withProduct({ description: 'd'.repeat(4000) }))).toBe(true);
  });

  it('refuses what the owner cannot store, so no admitted request fails to plan', () => {
    expect(accepts(withProduct({ name: '   ' }))).toBe(false);
    expect(accepts(withProduct({ localized: [{ locale: ' cs', name: 'x' }] }))).toBe(false);
    expect(accepts(withProduct({ localized: [{ locale: 'cs', name: '   ' }] }))).toBe(false);
    expect(accepts(withVariant({ localized: [{ description: '', locale: 'cs' }] }))).toBe(false);
  });

  it('limits a product to thirty-two owner effects and a request to sixteen plan items', () => {
    expect(accepts(withVariant({ localized: texts(31) }))).toBe(true);
    expect(accepts(withVariant({ localized: texts(32) }))).toBe(false);
    expect(accepts(withProduct({ categoryIds: categoryIds(31) }))).toBe(true);
    expect(accepts(withProduct({ categoryIds: categoryIds(32) }))).toBe(false);
    const priced = { name: 'P', variants: [{ prices: [price] }] };
    expect(accepts({ products: Array.from({ length: 8 }, () => priced) })).toBe(true);
    expect(accepts({ products: Array.from({ length: 9 }, () => priced) })).toBe(false);
  });

  it('checks the identifier, lifecycle and localized texts', () => {
    expect(accepts(withProduct({ identifier: { type: 'upc', value: 'x' } }))).toBe(false);
    expect(accepts(withProduct({ identifier: { type: 'sku' } }))).toBe(false);
    expect(accepts(withProduct({ lifecycle: 'WORK_IN_PROGRESS' }))).toBe(false);
    expect(accepts(withProduct({ lifecycle: 'active' }))).toBe(false);
    expect(accepts(withProduct({ localized: [{ name: 'x' }] }))).toBe(false);
    expect(accepts(withProduct({ localized: [{ locale: '' }] }))).toBe(false);
    expect(accepts(withProduct({ localized: [{ locale: 'l'.repeat(101) }] }))).toBe(false);
    expect(accepts(withProduct({ localized: [{ locale: 'cs', name: 'n'.repeat(241) }] }))).toBe(false);
    expect(accepts(withProduct({ localized: [{ description: 'd'.repeat(4001), locale: 'cs' }] }))).toBe(false);
    expect(accepts(withProduct({ localized: [{ locale: 'cs' }] }))).toBe(true);
  });

  it('checks the GTIN and the references', () => {
    expect(accepts(withProduct({ gtin: { code: '8590000000011' } }))).toBe(false);
    expect(accepts(withProduct({ gtin: { effectiveAt: '2026-01-01T00:00:00Z' } }))).toBe(false);
    expect(accepts(withProduct({ gtin: { code: '8590000000011', effectiveAt: 'soon' } }))).toBe(false);
    expect(accepts(withProduct({ productTypeId: productRef }))).toBe(false);
    expect(accepts(withProduct({ productTypeId: 'type-1' }))).toBe(false);
    expect(accepts(withProduct({ categoryIds: ['category-1'] }))).toBe(false);
    expect(accepts(withProduct({ categoryIds: [] }))).toBe(true);
    expect(accepts(withProduct({ categories: [] }))).toBe(false);
  });

  it('rejects product-level prices, the contract version, a fixture id and unknown properties', () => {
    for (const extra of [
      { prices: [price] },
      { contractVersion: 'INTERNAL_C14' },
      { fixtureId: 'x' },
      { unknown: 1 },
      { metadata: {} },
    ]) {
      expect(accepts(withProduct(extra)), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts({ contractVersion: 'INTERNAL_C14', products: [product] })).toBe(false);
    expect(accepts({ plan: {}, products: [product] })).toBe(false);
  });
});

describe('Symmy products batch request: brand, manufacturer, relationships, media, sizes', () => {
  it('requires the brand id only for kind brand', () => {
    const brandId = uuid('3');
    expect(accepts(withProduct({ brand: { brandId, kind: 'brand' } }))).toBe(true);
    expect(accepts(withProduct({ brand: { kind: 'unknown' } }))).toBe(true);
    expect(accepts(withProduct({ brand: { kind: 'confirmed_unbranded' } }))).toBe(true);
    expect(accepts(withProduct({ brand: { kind: 'brand' } }))).toBe(false);
    expect(accepts(withProduct({ brand: { kind: 'other' } }))).toBe(false);
    expect(accepts(withProduct({ brand: { brandId, kind: 'unknown' } }))).toBe(false);
    expect(accepts(withProduct({ brand: { brandId: 'brand-1', kind: 'brand' } }))).toBe(false);
  });

  it('requires the manufacturer target id that matches its kind', () => {
    const partyId = '77777777-7777-4777-8777-777777777777';
    expect(accepts(withProduct({ manufacturer: { target: { kind: 'PARTY', partyId } } }))).toBe(true);
    expect(accepts(withProduct({ manufacturer: { target: { kind: 'PARTY' } } }))).toBe(false);
    expect(accepts(withProduct({ manufacturer: { target: { kind: 'LEGAL_ENTITY', partyId } } }))).toBe(false);
    expect(accepts(withProduct({ manufacturer: { target: { kind: 'COMPANY', partyId } } }))).toBe(false);
    expect(accepts(withProduct({ manufacturer: {} }))).toBe(false);
    expect(
      accepts(
        withProduct({
          manufacturer: {
            effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2027-01-01T00:00:00Z' },
            target: { kind: 'PARTY', partyId },
          },
        }),
      ),
    ).toBe(true);
  });

  it('checks relationships and takes exactly one target id', () => {
    const related = (target: Json, type = 'SUCCESSOR') => withProduct({ relationships: [{ target, type }] });
    expect(accepts(related({ productId }, 'ACCESSORY_FOR'))).toBe(true);
    expect(accepts(related({ variantId }))).toBe(true);
    expect(accepts(related({ productId }, 'RELATED_PRODUCT'))).toBe(true);
    expect(accepts(related({ productId }, 'PARENT'))).toBe(false);
    expect(accepts(withProduct({ relationships: [{ type: 'SUCCESSOR' }] }))).toBe(false);
    expect(accepts(related({ unitId }))).toBe(false);
    expect(accepts(related({ productId, variantId }))).toBe(false);
    expect(accepts(related({}))).toBe(false);
    expect(accepts(related(productRef))).toBe(false);
    expect(accepts(withProduct({ relationships: [{ target: { productId } }] }))).toBe(false);
  });

  it('requires every media field', () => {
    const media = { order: 1, purpose: 'GALLERY', resourceId: 'asset-1', resourceKind: 'MEDIA' };
    expect(accepts(withProduct({ media: [media] }))).toBe(true);
    for (const key of Object.keys(media)) {
      const rest = Object.fromEntries(Object.entries(media).filter(([name]) => name !== key));
      expect(accepts(withProduct({ media: [rest] })), key).toBe(false);
    }
    expect(accepts(withProduct({ media: [{ ...media, resourceKind: 'VIDEO' }] }))).toBe(false);
    expect(accepts(withProduct({ media: [{ ...media, order: '1' }] }))).toBe(false);
  });

  it('accepts sizes as plain ids', () => {
    expect(accepts(withProduct({ sizeIds: ['S', 'M'] }))).toBe(true);
    expect(accepts(withProduct({ sizeIds: [productRef] }))).toBe(false);
    expect(accepts(withProduct({ sizeIds: [''] }))).toBe(false);
  });
});

describe('Symmy products batch request: attributes', () => {
  const attributeDefinitionId = uuid('4');
  const withAttribute = (values: Json) => withProduct({ attributes: [{ attributeDefinitionId, values }] });

  it('accepts text, controlled, measurement and special values', () => {
    expect(accepts(withAttribute([{ kind: 'TEXT', text: 'red' }]))).toBe(true);
    expect(accepts(withAttribute([{ kind: 'CONTROLLED', valueId: uuid('5') }]))).toBe(true);
    expect(accepts(withAttribute([{ amount: 2.5, kind: 'MEASUREMENT', unit: 'kg' }]))).toBe(true);
    for (const state of ['UNKNOWN', 'NONE', 'NOT_APPLICABLE']) {
      expect(accepts(withAttribute([{ kind: 'SPECIAL', state }])), state).toBe(true);
    }
  });

  it('rejects an incomplete or mixed value and a missing definition', () => {
    for (const value of [
      { kind: 'TEXT' },
      { kind: 'TEXT', text: 1 },
      { kind: 'CONTROLLED' },
      { kind: 'CONTROLLED', valueId: 'value-1' },
      { amount: '2.5', kind: 'MEASUREMENT', unit: 'kg' },
      { amount: 2.5, kind: 'MEASUREMENT' },
      { kind: 'SPECIAL', state: 'MAYBE' },
      { kind: 'SPECIAL' },
      { kind: 'RANGE' },
      { kind: 'TEXT', state: 'NONE', text: 'x' },
    ]) {
      expect(accepts(withAttribute([value])), JSON.stringify(value)).toBe(false);
    }
    expect(accepts(withProduct({ attributes: [{ values: [{ kind: 'TEXT', text: 'x' }] }] }))).toBe(false);
    expect(accepts(withProduct({ attributes: [{ attributeDefinitionId: 'definition-1' }] }))).toBe(false);
  });
});

describe('Symmy products batch request: variants', () => {
  it('accepts a variant with every field', () => {
    expect(
      accepts(
        withVariant({
          attributes: [{ attributeDefinitionId: uuid('4'), values: [] }],
          gtin: { code: '8590000000011', effectiveAt: '2026-01-01T00:00:00Z' },
          lifecycle: 'WORK_IN_PROGRESS',
          localized: [{ locale: 'cs', name: 'Varianta' }],
          sku: 'SKU-1-A',
        }),
      ),
    ).toBe(true);
    expect(accepts(withVariant({ identifier: { type: 'variantId', value: 'v-1' } }))).toBe(true);
    expect(accepts(withVariant({ identifier: { type: 'ean', value: '8590000000011' } }))).toBe(true);
  });

  it('checks the variant identifier and lifecycle', () => {
    expect(accepts(withVariant({ identifier: { type: 'erpId', value: 'x' } }))).toBe(false);
    expect(accepts(withVariant({ lifecycle: 'DRAFT' }))).toBe(false);
    expect(accepts(withVariant({ lifecycle: 'ACTIVE' }))).toBe(true);
    expect(accepts(withVariant({ lifecycle: 'RETIRED' }))).toBe(true);
  });

  it('accepts a price with the optional price group, scope and unit basis', () => {
    expect(accepts(withVariant({ prices: [price] }))).toBe(true);
    expect(
      accepts(
        withVariant({
          prices: [
            {
              ...price,
              commercialScope: {
                channelId: 'B2B',
                marketId: '99999999-9999-4999-8999-999999999999',
                sellingLegalEntityId: '88888888-8888-4888-8888-888888888888',
              },
              effectiveFrom: '2026-01-01T00:00:00Z',
              priceGroupCode: 'cz-wholesale',
              unitBasis: { quantity: '1', unitId },
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('accepts only the owner channels as a channel id', () => {
    expect(accepts(channel('B2C'))).toBe(true);
    expect(accepts(channel('B2B'))).toBe(true);
    expect(accepts(channel('retail'))).toBe(false);
    expect(accepts(channel(productId))).toBe(false);
  });

  it('rejects a bad price', () => {
    for (const extra of [
      { amount: '-1' },
      { amount: 10 },
      { amount: '1.1234567891' },
      { currencyCode: 'czk' },
      { currencyCode: 'QQQ' },
      { effectiveFrom: 'soon' },
      { priceGroupCode: '' },
      { unitBasis: { quantity: '0', unitId } },
      { unitBasis: { quantity: '1' } },
      { priceId: productId },
      { priceGroupId },
    ]) {
      expect(accepts(withVariant({ prices: [{ ...price, ...extra }] })), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts(withVariant({ prices: [{ currencyCode: 'CZK' }] }))).toBe(false);
    expect(accepts(withVariant({ prices: [{ amount: '1' }] }))).toBe(false);
  });

  it('rejects unknown variant properties and null', () => {
    expect(accepts(withVariant({ name: 'x' }))).toBe(false);
    expect(accepts(withVariant({ unknown: 1 }))).toBe(false);
    expect(accepts(withVariant({ prices: null }))).toBe(false);
    expect(accepts(withProduct({ description: null }))).toBe(false);
  });
});
