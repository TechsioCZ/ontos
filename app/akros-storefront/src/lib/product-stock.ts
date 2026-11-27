import type { Dictionary } from "@/i18n";

/**
 * The owner decides whether a unit can be bought (`catalog-projection`); the storefront never
 * decides again. „below-package“: the owner holds stock but less than the unit's first orderable
 * quantity (its minimum rounded up to whole packages), so it is not sold: worded „Skladem 6 ks,
 * prodej po 10 ks“ in the unavailable tone.
 */
export type ProductStockStatus = "in-stock" | "below-package" | "out-of-stock" | "unknown";

/** Stock held below one first order: what is on hand and what one concrete unit sells from. */
export interface StockBelowPackage {
  stockOnHand: number;
  /** Absent for a group of several variants: each has its own. */
  firstOrderableQuantity?: number;
}

export const getProductStockStatus = ({
  availabilityUnknown,
  belowPackage,
  stockCount,
}: {
  availabilityUnknown?: boolean;
  belowPackage?: StockBelowPackage;
  /** Sellable stock: 0 whenever the owner does not sell the unit. */
  stockCount: number;
}): ProductStockStatus => {
  if (availabilityUnknown) return "unknown";
  if (stockCount > 0) return "in-stock";
  return belowPackage ? "below-package" : "out-of-stock";
};

/**
 * The shop's only words for a stock status, on every surface: cards, header suggestions, search results, the product
 * page and its variant table, the variant dialog, favourites and the cart. Below one package they name both quantities
 * of a unit; any other state reads the same for every unit and every count.
 */
export const stockStatusLabel = (
  cs: Dictionary,
  status: ProductStockStatus,
  belowPackage?: StockBelowPackage,
  unit?: string,
): string =>
  status === "below-package" &&
  belowPackage?.firstOrderableQuantity !== undefined &&
  unit !== undefined
    ? cs.product.belowPackageCount(
        belowPackage.stockOnHand,
        belowPackage.firstOrderableQuantity,
        unit,
      )
    : cs.product.stockStatus[status];

/**
 * The ui-kit stock badge knows three tones: „nelze ověřit“ uses the cautionary one, stock below one
 * package (which cannot be bought) the unavailable one.
 */
export const productStockTone = (
  status: ProductStockStatus,
): "in-stock" | "limited-stock" | "out-of-stock" =>
  status === "unknown" ? "limited-stock" : status === "below-package" ? "out-of-stock" : status;
