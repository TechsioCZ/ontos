// After a rollback the release before classifications prices every untiered price from the document's `vatRate`
// (first tier, else net + vatRate; a product with real variants at its variants' lowest), ignoring any stored gross. So
// the `vatRate` this release writes into a product document must make that release charge exactly what this release
// charges now, for the product and every variant: before and after Tax priced the company, after a price change at
// the rate Tax gives, for a tiered product and for N1's jacket (a mistyped product net, five consistent variants).
// Only variants that disagree with one another cannot all be reproduced: then the lower rate, so nobody pays more.
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ProductSchema, grossUnitPriceMinor } from '../../shared/domain/merchandise-model.ts';
import type { Product } from '../../shared/domain/merchandise-model.ts';
import { rollbackVatRateOf } from '../../src/services/merchandise-store.ts';
import { realVariantsOf, stockLevelsOf, toProductRecord } from '../../src/services/stock-levels.ts';
import { TEST_RATES } from '../support/tax-fixtures.ts';

const decodeProduct = Schema.decodeUnknownSync(ProductSchema);
const base = {
  active: true,
  category: 'Katalog',
  createdAt: '2026-10-19T08:00:00.000Z',
  lowStockThreshold: 0,
  priceHistory: [],
  unit: 'ks',
  updatedAt: '2026-10-19T08:00:00.000Z',
};
const variant = (id: string, priceMinor: number, grossPriceMinor: number) => ({
  attributes: '',
  grossPriceMinor,
  id,
  name: id,
  priceMinor,
  sku: id.toUpperCase(),
});

/** Exactly what the release before classifications charges for each price (`stock-levels.ts:111,139-140` there). */
const oldReleaseCharges = (product: Product, vatRate: number): readonly number[] => {
  const variants = realVariantsOf(product);
  return variants.length === 0
    ? [product.priceTiers?.[0]?.priceMinor ?? grossUnitPriceMinor(product.currentPriceMinor, vatRate)]
    : variants.map((entry) => entry.priceTiers?.[0]?.priceMinor ?? grossUnitPriceMinor(entry.priceMinor, vatRate));
};
/** What this release charges for each price now. */
const newReleaseCharges = (product: Product, held: Readonly<Record<string, number>>): readonly number[] => {
  const record = toProductRecord(product, stockLevelsOf([], product.id), TEST_RATES, held);
  return record.variantRecords === undefined || record.variantRecords.length === 0
    ? [record.grossPriceMinor ?? Number.NaN]
    : record.variantRecords.map((entry) => entry.grossPriceMinor ?? Number.NaN);
};

const bookIt = (net: number, gross: number) =>
  decodeProduct({
    ...base,
    currentPriceMinor: net,
    grossPriceMinor: gross,
    id: 'book-it',
    name: 'BOOK-IT',
    sku: 'BOOK-IT',
    taxClassificationCode: 'cz.vat.reduced',
  });
const HELD = { 'book-it': 10 };
const NONE = {};

describe('the rollback vatRate makes the release before classifications charge what this release charges', () => {
  for (const [name, product, held, rate] of [
    ['BOOK-IT while held at 10 %', bookIt(49_000, 53_900), HELD, 10],
    [
      'BOOK-IT after Tax priced the company (gross still stored at 10 %; also after a rename)',
      bookIt(49_000, 53_900),
      NONE,
      10,
    ],
    ['BOOK-IT after a price change at the 12 % Tax gives', bookIt(50_000, grossUnitPriceMinor(50_000, 12)), NONE, 12],
    [
      'a tiered reduced product (both releases sell its first tier)',
      decodeProduct({
        ...base,
        currentPriceMinor: 25_804,
        grossPriceMinor: 28_900,
        id: 'kava',
        name: 'Káva',
        priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: 25_804, priceMinor: 28_900 }],
        sku: 'KAVA',
        taxClassificationCode: 'cz.vat.reduced',
      }),
      NONE,
      12,
    ],
    [
      "N1's jacket 38SA073510-BLK: product net mistyped (18 780), five consistent variants at 8 780 / 10 623,80",
      decodeProduct({
        ...base,
        currentPriceMinor: 1_878_000,
        grossPriceMinor: 1_062_380,
        id: 'spyder-jacket',
        name: 'Pánská bunda Spyder Vyper Jacket – černá',
        sku: '38SA073510-BLK',
        taxClassificationCode: 'cz.vat.standard',
        variants: ['S', 'M', 'L', 'XL', 'XXL'].map((size) => variant(`38SA073510-BLK-${size}`, 878_000, 1_062_380)),
      }),
      NONE,
      21,
    ],
  ] as const) {
    it(name, () => {
      const written = rollbackVatRateOf(product, TEST_RATES, held);
      expect(written).toBe(rate);
      expect(oldReleaseCharges(product, written)).toEqual(newReleaseCharges(product, held));
    });
  }

  it('variants that disagree: the lower rate, so after a rollback nobody pays more than now', () => {
    const product = decodeProduct({
      ...base,
      currentPriceMinor: 30_000,
      id: 'book-it',
      name: 'BOOK-IT',
      sku: 'BOOK-IT',
      taxClassificationCode: 'cz.vat.reduced',
      variants: [variant('yearly', 30_000, 33_000), variant('monthly', 40_000, grossUnitPriceMinor(40_000, 12))],
    });
    const written = rollbackVatRateOf(product, TEST_RATES, NONE);
    expect(written).toBe(10);
    const after = oldReleaseCharges(product, written);
    const now = newReleaseCharges(product, NONE);
    expect(after[0]).toBe(now[0]);
    expect(after.every((charged, index) => charged <= (now[index] ?? 0))).toBe(true);
  });
});
