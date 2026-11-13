// After a rollback the release before classifications prices every untiered price from the document's `vatRate`
// (first tier, else net + vatRate; a product with real variants at its variants' lowest), ignoring any stored gross.
// While the company still sells at the migrated rates that rate is fixed by the migration's hold trigger (a held product
// its held rate, reduced 12 %, standard 21 %): it must never move a hold. Once Tax priced the company it is the highest
// of the classification's rates at which the old release charges nothing above what this release charges now.
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

const reduced = (id: string, net: number, gross: number | undefined, variants?: readonly unknown[]) =>
  decodeProduct(
    Object.fromEntries([
      ...Object.entries(base),
      ['currentPriceMinor', net],
      ['id', id],
      ['name', id],
      ['sku', id.toUpperCase()],
      ['taxClassificationCode', 'cz.vat.reduced'],
      ...present('grossPriceMinor', gross),
      ...present('variants', variants),
    ]),
  );
const HELD = { 'book-it': 10 };
const NONE = {};
const MIGRATED = true;
const TAX_PRICED = false;

describe('while the company sells at the migrated rates, the document carries exactly the migration rate', () => {
  it('a held product its held rate, whatever its prices', () => {
    for (const product of [
      reduced('book-it', 49_000, 53_900),
      reduced('book-it', 50_000, grossUnitPriceMinor(50_000, 12)),
      reduced('book-it', 30_000, undefined, [variant('yearly', 30_000, 33_000), variant('monthly', 40_000)]),
    ]) {
      expect(rollbackVatRateOf(product, TEST_RATES, HELD, MIGRATED)).toBe(10);
    }
  });

  it('a reduced product not held 12 %, even when its stored gross does not round-trip at 12 % by a haléř', () => {
    // 25 803 + 12 % is 28 899,36 → 28 899; a gross entered as 28 898 is a haléř below it.
    const grossEntered = reduced('kava', 25_803, 28_898);
    expect(grossUnitPriceMinor(25_803, 12)).toBe(28_899);
    expect(rollbackVatRateOf(grossEntered, TEST_RATES, NONE, MIGRATED)).toBe(12);
    expect(rollbackVatRateOf(reduced('kava', 25_804, 28_900), TEST_RATES, NONE, MIGRATED)).toBe(12);
  });

  it('a standard product 21 %', () => {
    const jacket = decodeProduct({
      ...base,
      currentPriceMinor: 1_878_000,
      grossPriceMinor: 1_062_380,
      id: 'spyder-jacket',
      name: 'Pánská bunda Spyder Vyper Jacket – černá',
      sku: '38SA073510-BLK',
      taxClassificationCode: 'cz.vat.standard',
      variants: ['S', 'M', 'L', 'XL', 'XXL'].map((size) => variant(`38SA073510-BLK-${size}`, 878_000, 1_062_380)),
    });
    expect(rollbackVatRateOf(jacket, TEST_RATES, NONE, MIGRATED)).toBe(21);
  });
});

describe('once Tax priced the company: the highest rate at which nobody pays more after a rollback', () => {
  for (const [name, product, rate] of [
    ['BOOK-IT, its gross still stored at 10 % (also after a rename)', reduced('book-it', 49_000, 53_900), 10],
    [
      'BOOK-IT after a price change at the 12 % Tax gives',
      reduced('book-it', 50_000, grossUnitPriceMinor(50_000, 12)),
      12,
    ],
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
      12,
    ],
    [
      'BOOK-IT with its yearly variant at 10 % and two new variants priced at 12 %: never the majority 12 %',
      reduced('book-it', 30_000, undefined, [
        variant('yearly', 30_000, 33_000),
        variant('monthly', 40_000, grossUnitPriceMinor(40_000, 12)),
        variant('weekly', 12_000, grossUnitPriceMinor(12_000, 12)),
      ]),
      10,
    ],
    ['a reduced price entered a haléř below its 12 % recomputation', reduced('kava', 25_803, 28_898), 10],
  ] as const) {
    it(name, () => {
      const written = rollbackVatRateOf(product, TEST_RATES, NONE, TAX_PRICED);
      expect(written).toBe(rate);
      const after = oldReleaseCharges(product, written);
      const now = newReleaseCharges(product, NONE);
      expect(after.every((charged, index) => charged <= (now[index] ?? 0))).toBe(true);
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
 * Exclusion 1, inherent to the old release and on stage today regardless of this deploy: a price stored below what the
 * old release recomputes at the lowest rate this document may carry (standard 21 %, reduced 10 %; while migrated, the
 * migration's own rate). The old release charges that recomputation today already. Exclusion 2 (a non-payer company's
 * prices entered after the deploy, sold at 0 %) is not generated: these products are a VAT payer's.
 */
const inherentToOldRelease = (product: Product, unit: number, lowest: number) => {
  const units = realVariantsOf(product);
  const priced = units[unit] ?? product;
  const storedGross = priced.priceTiers?.[0] === undefined ? priced.grossPriceMinor : undefined;
  const recomputed = grossUnitPriceMinor(units[unit]?.priceMinor ?? product.currentPriceMinor, lowest);
  return storedGross !== undefined && storedGross < recomputed;
};

describe('property: after a rollback the old release charges no sellable unit more than this release charges now', () => {
  it('holds for 5 000 random products, with exactly the two exclusions inherent to the old release', () => {
    const random = generator(20_261_113);
    let checked = 0;
    for (let index = 0; index < 5000; index += 1) {
      const { held, product, standard } = randomProduct(random, index);
      const migrated = random.chance(0.5);
      const holds = migrated && held ? HELD : NONE;
      const written = rollbackVatRateOf(product, TEST_RATES, holds, migrated);
      const now = newReleaseCharges(product, holds);
      const lowest = migrated ? written : Math.min(...(standard ? [21] : [10, 12]));
      for (const [unit, charged] of oldReleaseCharges(product, written).entries()) {
        if (!inherentToOldRelease(product, unit, lowest)) {
          checked += 1;
          expect([index, unit, charged <= (now[unit] ?? Number.NaN)]).toEqual([index, unit, true]);
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});
