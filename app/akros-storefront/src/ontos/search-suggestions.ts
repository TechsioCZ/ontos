import type { CatalogCategory, CatalogSearchResult } from "@/mock-storefront/types";
import { normalizeCatalogSearchTerm } from "@/lib/product-variant-search";

/** One header-search product suggestion returned by POST /api/ontos/search (no server-side data). */
export interface RemoteSearchSuggestion {
  productId: string;
  slug: string;
  name: string;
  imageSrc: string;
  currency: "CZK";
  priceMinor: number;
  priceIsFrom: boolean;
  matchingVariantCount: number;
  variant?: { sku: string; label: string };
}
/** One header-search category suggestion; the browser no longer holds the whole category tree. */
export interface RemoteCategorySuggestion {
  id: string;
  slug: string;
  name: string;
  /** Parent names, e.g. "Nerezový spojovací materiál › Šrouby". */
  trail: string;
}
export interface RemoteSearchResponse {
  items: RemoteSearchSuggestion[];
  total: number;
  categories?: RemoteCategorySuggestion[];
}

/** Kai's placeholder groups (a product literally named "AKCE") are not real goods. */
export const isPlaceholderGroup = (name: string) =>
  name.trim().toLocaleUpperCase("cs-CZ") === "AKCE";

/** Real products first; placeholder groups keep their place in the total but move to the end. */
export const placeholdersLast = <T extends { name: string }>(products: T[]): T[] => [
  ...products.filter((product) => !isPlaceholderGroup(product.name)),
  ...products.filter((product) => isPlaceholderGroup(product.name)),
];

/** Same matching and ranking as Kai's header search: exact name, then prefix, then substring. */
export function matchCategories(
  categories: CatalogCategory[],
  getTrail: (category: CatalogCategory) => CatalogCategory[],
  query: string,
  limit = 4,
): RemoteCategorySuggestion[] {
  const normalizedQuery = normalizeCatalogSearchTerm(query);
  if (!normalizedQuery) return [];
  const rank = (normalizedName: string) =>
    normalizedName === normalizedQuery ? 0 : normalizedName.startsWith(normalizedQuery) ? 1 : 2;
  return categories
    .map((category) => ({ category, normalizedName: normalizeCatalogSearchTerm(category.name) }))
    .filter(({ normalizedName }) => normalizedName.includes(normalizedQuery))
    .sort((left, right) => rank(left.normalizedName) - rank(right.normalizedName))
    .slice(0, limit)
    .map(({ category }) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      trail: getTrail(category)
        .slice(0, -1)
        .map((parent) => parent.name)
        .join(" › "),
    }));
}

export function toRemoteSuggestion({
  product,
  matchingVariants,
}: CatalogSearchResult): RemoteSearchSuggestion {
  const variant = matchingVariants.length === 1 ? matchingVariants[0] : undefined;
  return {
    productId: product.id,
    slug: product.slug,
    name: product.name,
    imageSrc: variant?.imageSrc ?? product.imageSrc,
    currency: product.currency,
    priceMinor: variant?.priceMinor ?? product.priceMinor,
    priceIsFrom: !variant && product.detail.variants.length > 0,
    matchingVariantCount: matchingVariants.length,
    ...(variant ? { variant: { sku: variant.sku, label: variant.label } } : {}),
  };
}
