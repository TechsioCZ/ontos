// AKROS demo quantity pricing (ESHOP.md: the seed has „3 cenové úrovně“). Kai's feed has one price per item, so a
// few real products get two owner-side quantity breaks on top of their base price. The storefront quote and the
// owner order (tierPriceForQuantity) apply them; the product detail lists them („od 500 ks …“).

interface Tier {
  readonly minimumQuantity: number;
  readonly priceExcludingVatMinor: number;
  readonly priceMinor: number;
}
interface Priced {
  readonly minimumQuantity?: number | undefined;
  readonly packageQuantity?: number | undefined;
  readonly priceTiers?: readonly Tier[] | undefined;
}
interface PricedProduct extends Priced {
  readonly id: string;
  readonly variants?: readonly Priced[] | undefined;
  readonly vatRate?: number | undefined;
}

/** Products with photographed goods or the DIN 933 screws the demo shows; every variant gets the breaks. */
export const AKROS_TIERED_PRODUCT_IDS: ReadonlySet<string> = new Set([
  // VRUTY PRO TVRDÁ DŘEVA – TERRASSO-DRILL (5 variant, foto)
  'product-24034',
  // šroub M 8 × 20 DIN 933/A4
  'product-35372',
  // šroub M 6 × 25 DIN 933/A2
  'product-34459',
]);

/** −5 % from 5 packages, −10 % from 20 packages (net price; gross rounded half-up like the owner). */
const BREAKS = [
  { factor: 0.95, packages: 5 },
  { factor: 0.9, packages: 20 },
] as const;

const gross = (net: number, vatRate: number) => net + Math.floor((net * vatRate + 50) / 100);

/** Base tier plus two quantity breaks; unchanged when the item already has more than one tier or no base price. */
export const withDemoTiers = <T extends Priced>(item: T, vatRate: number): T => {
  const tiers = item.priceTiers ?? [];
  const [base] = tiers;
  if (tiers.length > 1 || base === undefined || base.priceExcludingVatMinor <= 0) {
    return item;
  }
  const step = item.packageQuantity !== undefined && item.packageQuantity > 0 ? item.packageQuantity : 100;
  const breaks = BREAKS.map(({ factor, packages }) => {
    const net = Math.round(base.priceExcludingVatMinor * factor);
    // Keep the historical tier JSON order used by the bundled baseline.
    const grossTier = { minimumQuantity: step * packages, priceMinor: gross(net, vatRate) };
    return Object.assign(grossTier, { priceExcludingVatMinor: net });
  }).filter((tier) => tier.minimumQuantity > (item.minimumQuantity ?? 1) && tier.priceExcludingVatMinor > 0);
  return { ...item, priceTiers: [base, ...breaks] };
};

/** Applies the demo quantity breaks to one of the selected products (and all its variants); others unchanged. */
export const applyDemoPriceTiers = <P extends PricedProduct>(product: P): P => {
  if (!AKROS_TIERED_PRODUCT_IDS.has(product.id)) {
    return product;
  }
  const vatRate = product.vatRate ?? 21;
  // A product with variants sells only its variants, so only they get the breaks.
  const tiered = (product.variants?.length ?? 0) > 0 ? product : withDemoTiers(product, vatRate);
  const variants = product.variants?.map((variant) => withDemoTiers(variant, vatRate));
  return variants === undefined ? tiered : { ...tiered, variants };
};
