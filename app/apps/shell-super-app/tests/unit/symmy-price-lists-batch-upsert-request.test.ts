import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyPriceListsBatchRequestSchema } from '../../api/symmy/price-lists-batch-upsert-request-contract.ts';
import { commercialScope, priceGroupRef, productRef, unitBasis, variantRef } from './symmy-price-requests.fixtures.ts';
import type { Json } from './symmy-price-requests.fixtures.ts';

// The HTTP layer decodes with excess properties rejected; the schema must hold under the same options.
const decode = (body: Json) =>
  Schema.decodeUnknownResult(SymmyPriceListsBatchRequestSchema, { onExcessProperty: 'error' })(body);
const accepts = (body: Json) => Result.isSuccess(decode(body));
const list = {
  businessCode: 'CZ_WHOLESALE',
  code: 'cz-wholesale',
  description: 'Wholesale prices',
  effectiveFrom: '2026-01-01T00:00:00Z',
  name: 'CZ wholesale',
  purpose: 'Wholesale customers',
};
const price = { amount: '25.50', currencyCode: 'CZK', effectiveFrom: '2026-01-01T00:00:00Z', productRef, variantRef };
const withList = (extra: Readonly<Record<string, Json>>) => ({ priceLists: [{ ...list, ...extra }] });
const withPrices = (prices: Json) => withList({ prices });

describe('Symmy price lists batch upsert request', () => {
  it('accepts a list without prices, and a list with a price', () => {
    expect(accepts({ priceLists: [list] })).toBe(true);
    expect(accepts(withPrices([price]))).toBe(true);
    expect(accepts(withPrices([{ ...price, commercialScope, unitBasis }]))).toBe(true);
  });

  it('normalizes a time without milliseconds to milliseconds', () => {
    const decoded = Schema.decodeUnknownSync(SymmyPriceListsBatchRequestSchema)({ priceLists: [list] });
    expect(decoded.priceLists[0].effectiveFrom).toBe('2026-01-01T00:00:00.000Z');
  });

  it('limits the request to sixteen price lists', () => {
    expect(accepts({ priceLists: Array.from({ length: 16 }, () => list) })).toBe(true);
    expect(accepts({ priceLists: Array.from({ length: 17 }, () => list) })).toBe(false);
    expect(accepts({ priceLists: [] })).toBe(false);
    expect(accepts({})).toBe(false);
  });

  it('limits price lists and prices together to sixteen', () => {
    expect(accepts({ priceLists: [{ ...list, prices: Array.from({ length: 15 }, () => price) }] })).toBe(true);
    expect(accepts({ priceLists: [{ ...list, prices: Array.from({ length: 16 }, () => price) }] })).toBe(false);
    const tenEach = Array.from({ length: 10 }, () => ({ ...list, prices: Array.from({ length: 10 }, () => price) }));
    expect(accepts({ priceLists: tenEach })).toBe(false);
  });

  it('requires code, businessCode, name, description, purpose and effectiveFrom', () => {
    for (const key of Object.keys(list)) {
      const rest = Object.fromEntries(Object.entries(list).filter(([name]) => name !== key));
      expect(accepts({ priceLists: [rest] }), key).toBe(false);
    }
  });

  it('checks the owner limits of each price list field', () => {
    for (const extra of [
      { businessCode: 'cz_wholesale' },
      { businessCode: '1ABC' },
      { businessCode: 'A'.repeat(65) },
      { businessCode: '' },
      { code: '' },
      { code: 'a'.repeat(81) },
      { code: 'has space' },
      { code: 'slash/code' },
      { name: '' },
      { name: 'n'.repeat(161) },
      { description: 'd'.repeat(2001) },
      { purpose: 'p'.repeat(1001) },
      { effectiveFrom: 'tomorrow' },
      { effectiveFrom: '2026-01-01' },
    ]) {
      expect(accepts(withList(extra)), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts(withList({ businessCode: 'A'.repeat(64), code: 'a'.repeat(80) }))).toBe(true);
  });

  it('rejects an end date, type, status, customer group, metadata and the contract version', () => {
    for (const extra of [
      { effectiveTo: '2026-12-31T00:00:00Z' },
      { endsAt: '2026-12-31T00:00:00Z' },
      { type: 'WHOLESALE' },
      { status: 'ACTIVE' },
      { customerGroupCode: 'g' },
      { metadata: {} },
      { contractVersion: 'INTERNAL_C14' },
      { unknown: 1 },
    ]) {
      expect(accepts(withList(extra)), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts({ contractVersion: 'INTERNAL_C14', priceLists: [list] })).toBe(false);
    expect(accepts({ fixtureId: 'x', priceLists: [list] })).toBe(false);
  });

  it('requires the product, variant, amount, currency and time of a price', () => {
    for (const key of Object.keys(price)) {
      const rest = Object.fromEntries(Object.entries(price).filter(([name]) => name !== key));
      expect(accepts(withPrices([rest])), key).toBe(false);
    }
  });

  it('checks amounts, currencies and references of a price', () => {
    for (const extra of [
      { amount: '-1' },
      { amount: 25 },
      { amount: '1e3' },
      { amount: '1.1234567891' },
      { amount: '' },
      { currencyCode: 'czk' },
      { currencyCode: 'CZ' },
      { currencyCode: 'QQQ' },
      { productRef: variantRef },
      { productRef: 'product-1' },
      { variantRef: productRef },
      { effectiveFrom: 'soon' },
      { priceRef: { ...productRef } },
      { reason: 'x' },
      { sourceAssertion: {} },
    ]) {
      expect(accepts(withPrices([{ ...price, ...extra }])), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts(withPrices([{ ...price, amount: '0' }]))).toBe(true);
    expect(accepts(withPrices([{ ...price, amount: '123456789012345678901234567890' }]))).toBe(false);
  });

  it('requires both parts of a commercial scope and a positive unit basis', () => {
    expect(accepts(withPrices([{ ...price, commercialScope: { channelId: 'B2B' } }]))).toBe(false);
    expect(accepts(withPrices([{ ...price, commercialScope: { marketId: 'm' } }]))).toBe(false);
    expect(accepts(withPrices([{ ...price, commercialScope: { channelId: 'B2X', marketId: 'm' } }]))).toBe(false);
    expect(accepts(withPrices([{ ...price, commercialScope: { channelId: 'B2B', marketId: '*' } }]))).toBe(false);
    expect(
      accepts(withPrices([{ ...price, commercialScope: { ...commercialScope, sellingLegalEntityId: 'x' } }])),
    ).toBe(false);
    expect(accepts(withPrices([{ ...price, unitBasis: { quantity: '0', unitRef: unitBasis.unitRef } }]))).toBe(false);
    expect(accepts(withPrices([{ ...price, unitBasis: { quantity: '1' } }]))).toBe(false);
    expect(accepts(withPrices([{ ...price, unitBasis: { unitRef: unitBasis.unitRef } }]))).toBe(false);
    expect(accepts(withPrices([{ ...price, unitBasis: { quantity: '1', unitRef: priceGroupRef } }]))).toBe(false);
  });

  it('refuses null in any field', () => {
    expect(accepts(withList({ description: null }))).toBe(false);
    expect(accepts(withPrices([{ ...price, commercialScope: null }]))).toBe(false);
    expect(accepts(withPrices(null))).toBe(false);
  });
});
