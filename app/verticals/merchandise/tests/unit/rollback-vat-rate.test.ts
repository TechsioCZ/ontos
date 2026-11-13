// After a rollback the release before classifications prices from the document's `vatRate`, ignoring any stored gross:
// on the storefront the first tier, else net + vatRate (a product with real variants at its variants' lowest); a line
// staff add to a VAT-inclusive order always net + vatRate. The rollback rate is the highest of the product's current
// classification's rates (reduced 10 / 12 %, standard 21 %) at which it charges nothing above what this release
// charges now, else the lowest. The window triggers never read it from this release's writes, so it does nothing else.
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
/** The entry `[key, value]` when the value is present, none otherwise: an absent stored gross stays absent. */
const present = <Value>(key: string, value: Value | undefined): readonly (readonly [string, Value])[] =>
  value === undefined ? [] : [[key, value]];
const variant = (id: string, priceMinor: number, grossPriceMinor?: number) =>
  Object.fromEntries([
    ['attributes', ''],
    ['id', id],
    ['name', id],
    ['priceMinor', priceMinor],
    ['sku', id.toUpperCase()],
    ...present('grossPriceMinor', grossPriceMinor),
  ]);

/** What the release before classifications charges for each unit: storefront (first tier, else net + rate) and staff. */
const oldReleaseCharges = (product: Product, vatRate: number): readonly (readonly [number, number])[] => {
  const variants = realVariantsOf(product);
  const units =
    variants.length === 0
      ? [{ net: product.currentPriceMinor, priced: product }]
      : variants.map((entry) => ({ net: entry.priceMinor, priced: entry }));
  return units.map(({ net, priced }) => {
    const recomputed = grossUnitPriceMinor(net, vatRate);
    return [priced.priceTiers?.[0]?.priceMinor ?? recomputed, recomputed] as const;
  });
};
/** What this release charges for each unit now, on the storefront and on a staff-added line alike. */
const newReleaseCharges = (product: Product, held: Readonly<Record<string, number>>): readonly number[] => {
  const record = toProductRecord(product, stockLevelsOf([], product.id), TEST_RATES, held);
  return record.variantRecords === undefined || record.variantRecords.length === 0
    ? [record.grossPriceMinor ?? Number.NaN]
    : record.variantRecords.map((entry) => entry.grossPriceMinor ?? Number.NaN);
};
const neverMoreAfterRollback = (product: Product, held: Readonly<Record<string, number>>, written: number) => {
  const now = newReleaseCharges(product, held);
  return oldReleaseCharges(product, written).every(
    ([storefront, staff], unit) => storefront <= (now[unit] ?? 0) && staff <= (now[unit] ?? 0),
  );
};

const productOf = (
  id: string,
  taxClassificationCode: 'cz.vat.reduced' | 'cz.vat.standard',
  net: number,
  gross: number | undefined,
  extra: readonly (readonly [string, unknown])[] = [],
) =>
  decodeProduct(
    Object.fromEntries([
      ...Object.entries(base),
      ['currentPriceMinor', net],
      ['id', id],
      ['name', id],
      ['sku', id.toUpperCase()],
      ['taxClassificationCode', taxClassificationCode],
      ...present('grossPriceMinor', gross),
      ...extra,
    ]),
  );
const reduced = (id: string, net: number, gross: number | undefined, variants?: readonly unknown[]) =>
  productOf(id, 'cz.vat.reduced', net, gross, present('variants', variants));
const tiered = (net: number, firstTier: number) =>
  productOf('kava', 'cz.vat.reduced', net, firstTier, [
    ['priceTiers', [{ minimumQuantity: 1, priceExcludingVatMinor: net, priceMinor: firstTier }]],
  ]);
const HELD = { 'book-it': 10 };
const NONE = {};

describe("the rollback rate: the highest of the current classification's rates at which nobody pays more", () => {
  for (const [name, product, held, rate] of [
    ['BOOK-IT held at 10 % (migrated rates): its prices reproduce at 10', reduced('book-it', 49_000, 53_900), HELD, 10],
    [
      'BOOK-IT held, with variants and no stored gross: they sell at 10, so 10',
      reduced('book-it', 30_000, undefined, [variant('yearly', 30_000), variant('monthly', 40_000)]),
      HELD,
      10,
    ],
    [
      'a held product reclassified to standard: no hold applies any more, 21',
      productOf('book-it', 'cz.vat.standard', 49_000, grossUnitPriceMinor(49_000, 21)),
      HELD,
      21,
    ],
    [
      'BOOK-IT after Tax priced the company, its gross still stored at 10 %',
      reduced('book-it', 49_000, 53_900),
      NONE,
      10,
    ],
    [
      'BOOK-IT after a price change at the 12 % Tax gives',
      reduced('book-it', 50_000, grossUnitPriceMinor(50_000, 12)),
      NONE,
      12,
    ],
    ['a reduced price entered a haléř below its 12 % recomputation: 10', reduced('kava', 25_803, 28_898), NONE, 10],
    [
      'a standard product reclassified to reduced, its gross stored at 21 %: 12',
      reduced('p2', 1000, grossUnitPriceMinor(1000, 21)),
      NONE,
      12,
    ],
    ['a reduced product whose first tier was built at 12 %', tiered(25_804, grossUnitPriceMinor(25_804, 12)), NONE, 12],
    [
      'a reduced product whose first tier was built at 10 %: 10, or staff-added lines would cost more than the tier',
      tiered(25_804, grossUnitPriceMinor(25_804, 10)),
      NONE,
      10,
    ],
    [
      'BOOK-IT with its yearly variant at 10 % and two new variants at 12 %: never the majority 12 %',
      reduced('book-it', 30_000, undefined, [
        variant('yearly', 30_000, 33_000),
        variant('monthly', 40_000, grossUnitPriceMinor(40_000, 12)),
        variant('weekly', 12_000, grossUnitPriceMinor(12_000, 12)),
      ]),
      NONE,
      10,
    ],
    [
      "N1's jacket 38SA073510-BLK: product net mistyped, five consistent variants at 21 %",
      productOf('spyder-jacket', 'cz.vat.standard', 1_878_000, 1_062_380, [
        ['variants', ['S', 'M', 'L', 'XL', 'XXL'].map((size) => variant(`38SA073510-BLK-${size}`, 878_000, 1_062_380))],
      ]),
      NONE,
      21,
    ],
  ] as const) {
    it(name, () => {
      const written = rollbackVatRateOf(product, TEST_RATES, held);
      expect(written).toBe(rate);
      expect(neverMoreAfterRollback(product, held, written)).toBe(true);
    });
  }
});

/** A small deterministic generator (a linear congruential sequence), so a failing case reproduces exactly. */
const generator = (seed: number) => {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  return {
    chance: (probability: number) => next() < probability,
    int: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)),
  };
};

type Random = ReturnType<typeof generator>;

/** The rate a generated stored gross was computed at: standard 21 %, held 10 %, otherwise 10 or 12 %. */
const grossRateOf = (random: Random, standard: boolean, held: boolean) => {
  if (standard) {
    return 21;
  }
  return held || random.chance(0.4) ? 10 : 12;
};

/** A stored gross: computed at a rate, entered by hand a few haléř off, or absent. */
const randomGross = (random: Random, net: number, standard: boolean, held: boolean) =>
  random.chance(0.2)
    ? undefined
    : grossUnitPriceMinor(net, grossRateOf(random, standard, held)) + (random.chance(0.25) ? random.int(-3, 3) : 0);

/** Sometimes a first price tier, which both releases sell as it is. */
const randomTiers = (random: Random, net: number, gross: number | undefined) =>
  present(
    'priceTiers',
    random.chance(0.15)
      ? [{ minimumQuantity: 1, priceExcludingVatMinor: net, priceMinor: gross ?? net * 2 }]
      : undefined,
  );

/** A random product of a VAT payer: standard or reduced, held or not, with or without variants, gross and tiers. */
const randomProduct = (random: Random, index: number) => {
  const standard = random.chance(0.4);
  const held = !standard && random.chance(0.3);
  const variants = random.chance(0.4)
    ? Array.from({ length: random.int(1, 4) }, (_, position) => {
        const net = random.int(100, 200_000);
        const gross = randomGross(random, net, standard, held);
        return Object.fromEntries([
          ...Object.entries(variant(`v${String(position)}`, net, gross)),
          ...randomTiers(random, net, gross),
        ]);
      })
    : undefined;
  const net = random.int(100, 2_000_000);
  const gross = randomGross(random, net, standard, held);
  const product = decodeProduct(
    Object.fromEntries([
      ...Object.entries(base),
      ['currentPriceMinor', net],
      ['id', held ? 'book-it' : `p${String(index)}`],
      ['name', 'Výrobek'],
      ['sku', `P${String(index)}`],
      ['taxClassificationCode', standard ? 'cz.vat.standard' : 'cz.vat.reduced'],
      ...present('grossPriceMinor', gross),
      ...randomTiers(random, net, gross),
      ...present('variants', variants),
    ]),
  );
  return { held, product, standard };
};

/**
 * Exclusion 1, inherent to the old release and on stage today regardless of this deploy: a price stored (as a gross or a
 * first tier) below what the old release computes at the lowest rate the product's classification admits (standard
 * 21 %, reduced 10 %); the old release charges that computation today already. Exclusion 2 (a non-payer company's
 * prices entered after the deploy, sold at 0 %) is not generated: these products are a VAT payer's.
 */
const inherentToOldRelease = (product: Product, unit: number) => {
  const units = realVariantsOf(product);
  const priced = units[unit] ?? product;
  const stored = priced.priceTiers?.[0]?.priceMinor ?? priced.grossPriceMinor;
  const lowest = product.taxClassificationCode === 'cz.vat.standard' ? 21 : 10;
  const computed = grossUnitPriceMinor(units[unit]?.priceMinor ?? product.currentPriceMinor, lowest);
  return stored !== undefined && stored < computed;
};

describe('property: after a rollback the old release charges no sellable unit more than this release charges now', () => {
  it('holds for 5 000 random products, on the storefront and on staff-added lines, with the two inherent exclusions', () => {
    const random = generator(20_261_113);
    let checked = 0;
    for (let index = 0; index < 5000; index += 1) {
      const { held, product } = randomProduct(random, index);
      const holds = held && random.chance(0.5) ? HELD : NONE;
      const written = rollbackVatRateOf(product, TEST_RATES, holds);
      const now = newReleaseCharges(product, holds);
      for (const [unit, [storefront, staff]] of oldReleaseCharges(product, written).entries()) {
        if (!inherentToOldRelease(product, unit)) {
          checked += 1;
          const charging = now[unit] ?? Number.NaN;
          expect([index, unit, storefront <= charging, staff <= charging]).toEqual([index, unit, true, true]);
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});
