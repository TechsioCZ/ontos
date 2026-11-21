import { CatalogPagePricesResponseSchema } from '@app/pricing/apis/catalog-page-prices';
import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { erpOfferFromSearch } from '../../src/products-admin/erp-offer.ts';
import { formatPrice, onHandRequestOf, pricesRequestOf, variantRows } from '../../src/products-admin/products-model.ts';
import type { PageProduct, VariantFigures } from '../../src/products-admin/products-model.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const unitId = '33333333-3333-4333-8333-333333333333';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const variantId = (index: number) => `00000000-0000-4000-8000-00000000000${String(index)}`;
const variantRef = (index: number) => ref('commerce.catalog.variant', variantId(index));
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');

const item: PageProduct = {
  productRef,
  variants: [1, 2, 3, 4, 5, 6].map((index) => ({
    lifecycle: index === 6 ? 'RETIRED' : 'ACTIVE',
    localized: { kind: 'MISSING_TRANSLATION', requestedLocale: 'cs-CZ' },
    options: index === 6 ? [] : [{ values: [{ kind: 'TEXT', text: `${String(index * 10)} mm` }] }],
    sku: `SKU-${String(index)}`,
    variantRef: variantRef(index),
  })),
};

const offer = Option.getOrThrow(
  erpOfferFromSearch(
    `?customerConfigurationId=akros-eshop&channelId=B2C&marketId=akros-cz&currencyCode=CZK&unitId=${unitId}`,
  ),
);

const unitBasis = { quantity: '1', unitRef: ref('commerce.catalog.product-unit', unitId) };
const selection = (index: number) => ({ catalogSelection: { productRef, variantRef: variantRef(index) }, unitBasis });
const priced = Schema.decodeUnknownSync(CatalogPagePricesResponseSchema)({
  _tag: 'CATALOG_PAGE_PRICED',
  effectiveAt: '2026-11-21T00:00:00.000Z',
  prices: [
    {
      ...selection(1),
      _tag: 'PRICE_FOUND',
      channelId: 'B2C',
      priceGroupSelector: { kind: 'NO_GROUP' },
      priceRef: {
        moduleId: 'commerce.pricing',
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'commerce.pricing.price',
        tenantId,
      },
      priceRevision: {
        effectiveFrom: '2026-11-20T00:00:00.000Z',
        monetaryAmount: { amount: '1234.5', currencyCode: 'CZK' },
        monetaryBoundary: 'PRE_TAX',
        revision: 1,
        revisionId: '66666666-6666-4666-8666-666666666666',
      },
      quantityTiers: { _tag: 'QUANTITY_TIERS_CURRENT', tiers: [] },
    },
    { ...selection(2), _tag: 'NO_APPLICABLE_PRICE', retryable: false },
    { ...selection(3), _tag: 'PRICING_CONFLICT', reason: 'COMPETING_CURRENT_EXACT_PRICES', retryable: false },
    { ...selection(4), _tag: 'PRICING_INDETERMINATE', reason: 'OWNER_STATE_UNAVAILABLE', retryable: true },
  ],
});

const answered: VariantFigures = {
  onHand: {
    kind: 'answered',
    value: [
      { outcome: 'ON_HAND', total: { amount: '42' }, variantRef: variantRef(1) },
      { outcome: 'NO_STOCK_ITEM', variantRef: variantRef(2) },
      { outcome: 'CONFLICTING_BINDINGS', variantRef: variantRef(3) },
      { outcome: 'NO_POSITION', variantRef: variantRef(4) },
      { outcome: 'ON_HAND_UNKNOWN', variantRef: variantRef(5) },
    ],
  },
  prices: { kind: 'answered', value: priced },
};

describe('staff product list model', () => {
  it('shows every stock outcome honestly and a missing price as missing', () => {
    const rows = variantRows(item, answered);
    expect(rows.map(({ price, sku, stock }) => ({ price, sku, stock }))).toEqual([
      {
        price: { amount: '1234.5', currencyCode: 'CZK', kind: 'PRICE' },
        sku: 'SKU-1',
        stock: { kind: 'ON_HAND', quantity: '42' },
      },
      { price: { kind: 'NO_PRICE' }, sku: 'SKU-2', stock: { kind: 'NO_STOCK_ITEM' } },
      { price: { kind: 'PRICING_CONFLICT' }, sku: 'SKU-3', stock: { kind: 'CONFLICTING_BINDINGS' } },
      { price: { kind: 'PRICING_INDETERMINATE' }, sku: 'SKU-4', stock: { kind: 'NO_POSITION' } },
      // A variant the price read did not answer is never given a price.
      { price: { kind: 'READ_FAILED' }, sku: 'SKU-5', stock: { kind: 'ON_HAND_UNKNOWN' } },
      { price: { kind: 'READ_FAILED' }, sku: 'SKU-6', stock: { kind: 'READ_FAILED' } },
    ]);
    expect(rows.map(({ options }) => options)).toEqual(['10 mm', '20 mm', '30 mm', '40 mm', '50 mm', '']);
  });

  it('tells an unset ERP offer from a failed read', () => {
    const [unset] = variantRows(item, { onHand: { kind: 'not_configured' }, prices: { kind: 'not_configured' } });
    expect(unset).toMatchObject({ price: { kind: 'NOT_CONFIGURED' }, stock: { kind: 'NOT_CONFIGURED' } });
    const [failed] = variantRows(item, { onHand: { kind: 'failed' }, prices: { kind: 'failed' } });
    expect(failed).toMatchObject({ price: { kind: 'READ_FAILED' }, stock: { kind: 'READ_FAILED' } });
  });

  it('asks Inventory and Pricing for the product variants under the ERP offer', () => {
    expect(onHandRequestOf(offer, item)).toEqual({
      customerConfigurationId: 'akros-eshop',
      variantRefs: item.variants.map((variant) => variant.variantRef),
    });
    const prices = pricesRequestOf(offer, item);
    expect(prices).toMatchObject({ channelId: 'B2C', currencyCode: 'CZK', marketId: 'akros-cz' });
    expect(prices.items[0]).toEqual({
      catalogSelection: { productRef, variantRef: variantRef(1) },
      unitBasis: { quantity: '1', unitRef: ref('commerce.catalog.product-unit', unitId) },
    });
  });

  it('needs a complete ERP offer in the URL', () => {
    expect(Option.isNone(erpOfferFromSearch('?channelId=B2C&marketId=akros-cz'))).toBe(true);
    expect(
      Option.isNone(
        erpOfferFromSearch(`?customerConfigurationId=x&channelId=B2X&marketId=m&currencyCode=CZK&unitId=${unitId}`),
      ),
    ).toBe(true);
  });

  it('formats an ERP price as money in the page language', () => {
    expect(formatPrice('1234.5', 'CZK', 'cs').replaceAll(/\s/gu, ' ')).toBe('1 234,50 Kč');
  });
});
