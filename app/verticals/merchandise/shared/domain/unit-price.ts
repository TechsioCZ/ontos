// The gross price one sellable unit (a product without variants, or a variant) sells at for a quantity. The owner
// record shows it, the storefront projects it and every checkout and staff line charges it, so a shopper is never
// shown one price and charged another.
import { grossUnitPriceMinor } from './merchandise-model.ts';
import type { Product } from './merchandise-model.ts';

type PriceTiers = Product['priceTiers'];

export interface BasePriced {
  /** The gross stored with the unit's net price when it was entered. */
  readonly grossPriceMinor?: number | undefined;
  /** The smallest quantity the unit sells in (1 when not stated). */
  readonly minimumQuantity?: number | undefined;
  readonly priceTiers?: PriceTiers;
}

/** The gross of the highest quantity break `quantity` reaches; undefined below the first break. */
export const tierPriceForQuantity = (tiers: PriceTiers, quantity: number): number | undefined =>
  tiers?.filter((tier) => tier.minimumQuantity <= quantity).toSorted((a, b) => b.minimumQuantity - a.minimumQuantity)[0]
    ?.priceMinor;

/**
 * The unit's gross below its first quantity break; undefined when it has none and is not sold below the break. In
 * order: the gross stored with its net price; without tiers, the net plus VAT at `rate`; otherwise the lowest-quantity
 * tier, when it is the unit's own (positive) net price rather than a discount or a surcharge and its gross is that net
 * plus VAT at `rate` (a held rate included), so a gross embedding another rate is never charged (AKROS imports its base
 * price as such a tier).
 */
export const baseGrossOf = (priced: BasePriced, net: number, rate: number | undefined): number | undefined => {
  if (priced.grossPriceMinor !== undefined) {
    return priced.grossPriceMinor;
  }
  const tiers = priced.priceTiers ?? [];
  if (tiers.length === 0) {
    return rate === undefined ? undefined : grossUnitPriceMinor(net, rate);
  }
  const [lowest] = tiers.toSorted((left, right) => left.minimumQuantity - right.minimumQuantity);
  return lowest !== undefined &&
    net > 0 &&
    rate !== undefined &&
    lowest.priceExcludingVatMinor === net &&
    lowest.priceMinor === grossUnitPriceMinor(net, rate)
    ? lowest.priceMinor
    : undefined;
};

/** The gross `quantity` of the unit costs: the break it reaches, else its base gross ({@link baseGrossOf}). */
export const grossForQuantity = (
  priced: BasePriced,
  net: number,
  rate: number | undefined,
  quantity: number,
): number | undefined => tierPriceForQuantity(priced.priceTiers, quantity) ?? baseGrossOf(priced, net, rate);

/**
 * The gross the unit's record shows: what its smallest sellable quantity costs ({@link grossForQuantity}), so a
 * listing never shows a price below its minimum that nobody can pay, and below the first break it is the price checkout
 * charges.
 */
export const shownGrossOf = (priced: BasePriced, net: number, rate: number | undefined): number | undefined =>
  grossForQuantity(priced, net, rate, priced.minimumQuantity ?? 1);
