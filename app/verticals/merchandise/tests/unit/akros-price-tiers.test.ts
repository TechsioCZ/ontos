import { expect, it } from 'effect-rstest';
import { AKROS_TIERED_PRODUCT_IDS, applyDemoPriceTiers } from '../../scripts/akros-price-tiers.ts';
import { buildAkrosEncoded } from '../../scripts/akros-catalog.mts';

const base = { minimumQuantity: 1, priceMinor: 524, priceExcludingVatMinor: 433 };

it('gives a selected product three price levels by whole packages, gross rounded like the owner', () => {
  const tiered = applyDemoPriceTiers({ id: 'product-35372', vatRate: 21, packageQuantity: 100, priceTiers: [base] });
  expect(tiered.priceTiers).toEqual([
    base,
    { minimumQuantity: 500, priceMinor: 497, priceExcludingVatMinor: 411 },
    { minimumQuantity: 2000, priceMinor: 472, priceExcludingVatMinor: 390 },
  ]);
  // Idempotent: a product that already has quantity breaks (or staff-edited tiers) is left alone.
  expect(applyDemoPriceTiers(tiered)).toBe(tiered);
  expect(applyDemoPriceTiers({ id: 'product-1', priceTiers: [base] }).priceTiers).toEqual([base]);
});

it('seeds at least three tiered products in the AKROS baseline (variants carry the breaks)', () => {
  const products = buildAkrosEncoded().products.filter((product) => AKROS_TIERED_PRODUCT_IDS.has(product.id));
  expect(products).toHaveLength(3);
  for (const product of products) {
    const units = (product.variants?.length ?? 0) > 0 ? product.variants! : [product];
    for (const unit of units) expect(unit.priceTiers?.length).toBe(3);
  }
});
