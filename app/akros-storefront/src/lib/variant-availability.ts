import type { Dictionary } from "@/i18n";
import { getProductStockStatus } from "@/lib/product-stock";

type AvailabilityInput = Parameters<typeof getProductStockStatus>[0];

/** The ui-kit AvailabilityStatus of one concrete item; OntOS-unknown stock stays „nelze ověřit“. */
export function describeVariantAvailability(cs: Dictionary, item: AvailabilityInput) {
  const stock = getProductStockStatus(item);
  const status =
    stock === "in-stock"
      ? "available"
      : stock === "limited-stock"
        ? "limited"
        : stock === "unknown"
          ? "unknown"
          : "unavailable";
  return { status, label: cs.product.stockStatus[stock] } as const;
}
