import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import type { CatalogProductSummary } from "@/mock-storefront/types";

export function getCatalogPriceLabel(
  product: Pick<CatalogProductSummary, "priceIsFrom" | "priceMinor" | "currency">,
): string {
  if (product.priceIsFrom) return cs.product.variantPrice;
  return product.priceMinor > 0
    ? formatPrice(product.priceMinor, product.currency)
    : cs.product.priceOnRequest;
}
