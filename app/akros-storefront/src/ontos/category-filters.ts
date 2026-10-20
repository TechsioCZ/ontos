import type { CatalogProduct } from "@/mock-storefront/types";
import { normalizeCatalogSearchTerm } from "@/lib/product-variant-search";
import { getProductStockStatus } from "@/lib/product-stock";

export type CategoryQuery = Record<string, string | string[] | undefined>;
export type CategoryFilters = ReturnType<typeof parseCategoryFilters>;
const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? "";
const price = (value: string) => {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const minor = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : undefined;
};

export function parseCategoryFilters(query: CategoryQuery) {
  const min = first(query.min);
  const max = first(query.max);
  const sort = first(query.sort);
  const availability = first(query.availability);
  return {
    q: first(query.q).trim().slice(0, 200),
    min: price(min) === undefined ? "" : min,
    max: price(max) === undefined ? "" : max,
    minMinor: price(min),
    maxMinor: price(max),
    availability:
      availability === "in-stock" || availability === "out-of-stock" ? availability : "",
    sort: sort === "price-asc" || sort === "price-desc" ? sort : "name",
  };
}

export function categoryFilterParams(filters: CategoryFilters) {
  return Object.fromEntries(
    Object.entries({
      q: filters.q,
      min: filters.min,
      max: filters.max,
      availability: filters.availability,
      sort: filters.sort === "name" ? "" : filters.sort,
    }).filter(([, value]) => value),
  );
}

export function filterCategoryProducts(products: CatalogProduct[], filters: CategoryFilters) {
  const term = normalizeCatalogSearchTerm(filters.q);
  const name = new Intl.Collator("cs-CZ", { numeric: true, sensitivity: "base" });
  return products
    .filter((product) => {
      if (
        term &&
        !normalizeCatalogSearchTerm(
          [
            product.name,
            product.sku,
            ...product.detail.variants.map((variant) => variant.sku),
          ].join(" "),
        ).includes(term)
      )
        return false;
      // Filter/sort the same owner-supplied unit/from price displayed on the card.
      if (filters.minMinor !== undefined && product.priceMinor < filters.minMinor) return false;
      if (filters.maxMinor !== undefined && product.priceMinor > filters.maxMinor) return false;
      const available = (product.detail.variants.length ? product.detail.variants : [product]).some(
        (item) => getProductStockStatus(item) === "in-stock",
      );
      if (filters.availability === "in-stock" && !available) return false;
      if (filters.availability === "out-of-stock" && available) return false;
      return true;
    })
    .sort((a, b) => {
      const difference =
        filters.sort === "price-asc"
          ? a.priceMinor - b.priceMinor
          : filters.sort === "price-desc"
            ? b.priceMinor - a.priceMinor
            : 0;
      return difference || name.compare(a.name, b.name) || a.id.localeCompare(b.id);
    });
}
