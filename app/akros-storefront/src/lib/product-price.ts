import { cs } from "@/i18n/cs";
import type { Dictionary } from "@/i18n";
import { CZK_MONEY, describeOfferPrice, type MoneyFormat } from "@/lib/format";
import type { CatalogProductSummary } from "@/ontos/catalog-types";

type CatalogPriceInput = Pick<CatalogProductSummary, "priceIsFrom" | "priceMinor" | "currency"> & {
  priceUnavailableReason?: string;
};

export type CatalogPrice =
  | { kind: "variant"; label: string }
  | { kind: "exact"; label: string }
  | { kind: "unavailable"; label: string; reason: string };

/**
 * Prices are shown only for a concrete catalog item: a product with several variants shows the
 * variant-price prompt instead of a group "from" price. A single variant, a selected variant or a product
 * without variants shows its exact OntOS price; a missing, zero or foreign-currency price is never formatted.
 */
export function describeCatalogPrice(
  product: CatalogPriceInput,
  dictionary: Dictionary = cs,
  money: MoneyFormat = CZK_MONEY,
): CatalogPrice {
  if (product.priceIsFrom) return { kind: "variant", label: dictionary.product.variantPrice };
  const price = describeOfferPrice({ ...product, priceIsFrom: false }, money, dictionary);
  return price.available
    ? { kind: "exact", label: price.label }
    : { kind: "unavailable", label: dictionary.product.priceUnavailable, reason: price.reason };
}

export function getCatalogPriceLabel(
  product: CatalogPriceInput,
  dictionary: Dictionary = cs,
  money: MoneyFormat = CZK_MONEY,
): string {
  return describeCatalogPrice(product, dictionary, money).label;
}
