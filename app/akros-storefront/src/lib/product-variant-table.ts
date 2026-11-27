import type { CatalogPurchaseVariant } from "@/ontos/catalog-types";
import type { VariantRangeFilter } from "@/lib/product-variant-filters";

/** Rows per page of a product's variant table; the server renders only the first page. */
export const VARIANT_PAGE_SIZE = 20;

export const formatVariantLabel = (variant: Pick<CatalogPurchaseVariant, "label">) => {
  const dimension = variant.label.match(/\bM\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/i);
  if (!dimension) return variant.label;

  return `M ${dimension[1]} × ${dimension[2]}`;
};

const variantCollator = new Intl.Collator("cs-CZ", {
  numeric: true,
  sensitivity: "base",
});

/** The table order, the same on the server (first page) and in the browser (every page). */
export const compareVariants = (
  left: Pick<CatalogPurchaseVariant, "label">,
  right: Pick<CatalogPurchaseVariant, "label">,
) => variantCollator.compare(formatVariantLabel(left), formatVariantLabel(right));

/**
 * A range filter as the server sends it with the first page: its distinct values (the slider's stops)
 * instead of one value per variant, which the browser reads once it holds every variant.
 */
export type VariantFilterBounds = Omit<VariantRangeFilter, "values"> & { stops: number[] };

export const toFilterBounds = ({ values, ...filter }: VariantRangeFilter): VariantFilterBounds => ({
  ...filter,
  stops: [...new Set(values.values())].sort((left, right) => left - right),
});

/** The server's first page of a long variant table; the rest loads on demand. */
export interface VariantTablePage {
  /** Every variant of the product. */
  total: number;
  /** Variants matching the `?variant=` search (equal to `total` without one). */
  matching: number;
  filters: VariantFilterBounds[];
}
