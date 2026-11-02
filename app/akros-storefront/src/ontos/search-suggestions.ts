import type { ProductGridItem } from "@/components/product-grid";
import type { Dictionary } from "@/i18n";
import type { StoreCurrency } from "@/lib/format";
import { getProductStockStatus } from "@/lib/product-stock";
import { buildVariantSelectionHref } from "@/lib/product-variant-links";
import type {
  CatalogCategory,
  CatalogParameter,
  CatalogProduct,
  CatalogProductSummary,
  CatalogProductVariant,
} from "@/ontos/catalog-types";
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";

/** One header-search product suggestion returned by POST /api/ontos/search from live OntOS catalog records. */
export interface RemoteSearchSuggestion {
  productId: string;
  slug: string;
  name: string;
  imageSrc: string;
  currency: StoreCurrency;
  priceMinor: number;
  priceIsFrom: boolean;
  /** Set when the price is missing, zero or in another currency; the suggestion then shows no amount. */
  priceUnavailableReason?: string;
  /** A variant group: the detail page pre-filters its variant table with the query. */
  hasVariants: boolean;
  /** The one concrete variant this suggestion stands for (single exact hit or a one-variant group). */
  variantLabel?: string;
  variantSku?: string;
  /** Unprefixed detail path: an exact variant hit opens `?variantIds=`, several hits the query-filtered table. */
  path?: string;
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
const isPlaceholderGroup = (name: string) => name.trim().toLocaleUpperCase("cs-CZ") === "AKCE";

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

/** Variants of one search hit, from a full OntOS product read (cards carry no variant records). */
export interface SearchVariantMatch {
  /** Kai's rule: exact SKU hits win, a product-level match needs no variant, else every matching variant. */
  matching: CatalogProductVariant[];
  /** The product's only variant, when it has exactly one. */
  only?: CatalogProductVariant;
}

const parameterText = (parameters: CatalogParameter[]) =>
  parameters.map(({ label, value, unit }) => `${label} ${value} ${unit}`).join(" ");

/** Which variants of a full product record a search query points at (same rule as Kai's catalog search). */
export function matchSearchVariants(product: CatalogProduct, query: string): SearchVariantMatch {
  const normalizedQuery = normalizeCatalogSearchTerm(query);
  const variants = product.detail.variants;
  const only = variants.length === 1 ? variants[0] : undefined;
  if (!normalizedQuery) return { matching: [], only };
  const matchingVariants = variants.filter((variant) =>
    matchesProductVariantSearch(variant, normalizedQuery),
  );
  const exactSkuMatches = matchingVariants.filter(
    (variant) => normalizeCatalogSearchTerm(variant.sku) === normalizedQuery,
  );
  if (exactSkuMatches.length > 0) return { matching: exactSkuMatches, only };
  const productMatches = normalizeCatalogSearchTerm(
    `${product.name} ${product.sku} ${product.description} ${parameterText(product.detail.parameters)}`,
  ).includes(normalizedQuery);
  return { matching: productMatches ? [] : matchingVariants, only };
}

/**
 * Detail path of one search hit. One matching variant opens exactly that variant (`?variantIds=`), several open
 * the variant table filtered by the query. Without a variant read (`match` absent) a variant group falls back to
 * the query filter.
 */
export function searchHitPath(
  slug: string,
  query: string,
  hasVariants: boolean,
  match?: SearchVariantMatch,
): string {
  const filtered = `/produkt/${slug}?${new URLSearchParams({ variant: query.trim() })}#product-variants`;
  if (!match) return hasVariants ? filtered : `/produkt/${slug}`;
  if (match.matching.length === 1) return buildVariantSelectionHref(slug, [match.matching[0].id]);
  return match.matching.length > 1 ? filtered : `/produkt/${slug}`;
}

/** One listing card as a header suggestion; `match` (from a full read) routes it to its exact variant. */
export function toRemoteSuggestion(
  product: CatalogProduct,
  query = "",
  match?: SearchVariantMatch,
): RemoteSearchSuggestion {
  const hasVariants = product.variantSummary.count > 0;
  const variant =
    match?.matching.length === 1
      ? match.matching[0]
      : match?.matching.length
        ? undefined
        : match?.only;
  const priceUnavailableReason = variant
    ? variant.priceUnavailableReason
    : product.priceUnavailableReason;
  return {
    productId: product.id,
    slug: product.slug,
    name: product.name,
    imageSrc: variant?.imageSrc ?? product.imageSrc,
    currency: product.currency,
    priceMinor: variant?.priceMinor ?? product.priceMinor,
    // A group of several variants has no single price: the suggestion shows the variant-price prompt.
    priceIsFrom: !variant && product.variantSummary.count > 1,
    ...(priceUnavailableReason ? { priceUnavailableReason } : {}),
    hasVariants,
    ...(variant ? { variantLabel: variant.label, variantSku: variant.sku } : {}),
    ...(query.trim() ? { path: searchHitPath(product.slug, query, hasVariants, match) } : {}),
  };
}

/**
 * One search-results card. A single matching variant shows that variant's image, price and stock and opens it
 * exactly; several matching variants open the query-filtered table. Without `match` a group keeps the filter link.
 */
export function toSearchGridItem(
  summary: CatalogProductSummary,
  query: string,
  dictionary: Dictionary,
  match?: SearchVariantMatch,
): ProductGridItem {
  if (!summary.hasVariants) return summary;
  const detailHref = searchHitPath(summary.slug, query, true, match);
  if (!match || match.matching.length === 0) return { ...summary, detailHref };
  if (match.matching.length > 1)
    return {
      ...summary,
      detailHref,
      searchMatchLabel: dictionary.search.matchingVariants(match.matching.length),
    };
  const [variant] = match.matching;
  const { priceUnavailableReason: _productReason, ...rest } = summary;
  void _productReason;
  return {
    ...rest,
    imageSrc: variant.imageSrc ?? summary.imageSrc,
    priceMinor: variant.priceMinor,
    originalPriceMinor: variant.originalPriceMinor,
    priceExcludingVatMinor: variant.priceTiers.find(
      (tier) => tier.priceMinor === variant.priceMinor,
    )?.priceExcludingVatMinor,
    ...(variant.priceUnavailableReason
      ? { priceUnavailableReason: variant.priceUnavailableReason }
      : {}),
    priceIsFrom: false,
    stock: {
      kind: "quantity",
      minimumQuantity: variant.minimumQuantity,
      packageQuantity: variant.packageQuantity,
      quantityStep: variant.quantityStep,
      status: getProductStockStatus(variant),
      stockCount: variant.stockCount,
      unit: variant.unit,
    },
    detailHref,
    variantId: variant.id,
    variantLabel: variant.label,
    productName: summary.name,
    searchMatchLabel: dictionary.search.variantMatch(variant.label, variant.sku),
  };
}
