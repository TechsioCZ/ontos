import { expect, it } from 'effect-rstest';
import { Effect } from 'effect';
import { AKROS_TIERED_PRODUCT_IDS, applyDemoPriceTiers } from '../../scripts/akros-price-tiers.ts';
import { buildAkrosEncoded } from '../../scripts/akros-catalog.mts';

/** A missing fixture value fails the test before its fields are read. */
const requireFixture = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) {
    expect.unreachable('The fixture must be present before its fields are read');
  }
  return value;
};

const base = { minimumQuantity: 1, priceExcludingVatMinor: 433, priceMinor: 524 };

it('gives a selected product three price levels by whole packages, gross rounded like the owner', () => {
  const tiered = applyDemoPriceTiers({ id: 'product-35372', packageQuantity: 100, priceTiers: [base], vatRate: 21 });
  expect(tiered.priceTiers).toEqual([
    base,
    { minimumQuantity: 500, priceExcludingVatMinor: 411, priceMinor: 497 },
    { minimumQuantity: 2000, priceExcludingVatMinor: 390, priceMinor: 472 },
  ]);
  // Idempotent: a product that already has quantity breaks (or staff-edited tiers) is left alone.
  expect(applyDemoPriceTiers(tiered)).toBe(tiered);
  expect(applyDemoPriceTiers({ id: 'product-1', priceTiers: [base] }).priceTiers).toEqual([base]);
});

it.effect('seeds at least three tiered products in the AKROS baseline (variants carry the breaks)', () =>
  Effect.gen(function* seededPriceTiers() {
    const products = (yield* buildAkrosEncoded()).products.filter((product) =>
      AKROS_TIERED_PRODUCT_IDS.has(product.id),
    );
    expect(products).toHaveLength(3);
    for (const product of products) {
      const units = (product.variants?.length ?? 0) > 0 ? requireFixture(product.variants) : [product];
      for (const unit of units) {
        expect(unit.priceTiers?.length).toBe(3);
      }
    }
  }),
);
