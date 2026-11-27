import type { Dictionary } from "@/i18n";
import { getProductStockStatus, stockStatusLabel } from "@/lib/product-stock";

type AvailabilityInput = Parameters<typeof getProductStockStatus>[0] & { unit: string };

/** The ui-kit AvailabilityStatus of one concrete item; OntOS-unknown stock stays „nelze ověřit“. */
export function describeVariantAvailability(cs: Dictionary, item: AvailabilityInput) {
  const stock = getProductStockStatus(item);
  const status =
    stock === "in-stock" ? "available" : stock === "unknown" ? "unknown" : "unavailable";
  return { status, label: stockStatusLabel(cs, stock, item.belowPackage, item.unit) } as const;
}
