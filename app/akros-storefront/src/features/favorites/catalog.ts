import type { CatalogProductSummary, CatalogProductVariant } from "@/ontos/catalog-types";
import { marketRequestHeaders } from "@/ontos/market-locale";

/** One product's live OntOS card and variants (`GET /api/ontos/product-variants/<slug>`). */
export interface FavoriteCatalogProduct {
  product: CatalogProductSummary;
  variants: CatalogProductVariant[];
}

export async function loadFavoriteProduct(
  slug: string,
  signal?: AbortSignal,
): Promise<FavoriteCatalogProduct> {
  const response = await fetch(`/api/ontos/product-variants/${encodeURIComponent(slug)}`, {
    headers: marketRequestHeaders(),
    signal,
  });
  if (!response.ok) throw new Error(`Product variants could not be loaded (${response.status}).`);
  return (await response.json()) as FavoriteCatalogProduct;
}
