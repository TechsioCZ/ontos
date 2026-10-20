import type { CatalogSearchResult } from "@/mock-storefront/types";

/** One header-search product suggestion returned by POST /api/ontos/search (no server-only data). */
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
export interface RemoteSearchResponse {
  items: RemoteSearchSuggestion[];
  total: number;
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
