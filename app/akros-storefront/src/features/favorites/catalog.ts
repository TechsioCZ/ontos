import type { CatalogProductSummary, CatalogProductVariant } from "@/ontos/catalog-types";
import { marketRequestHeaders } from "@/ontos/market-locale";

export interface FavoriteCatalogProduct {
  product: CatalogProductSummary;
  variants: CatalogProductVariant[];
}

export async function loadFavoriteProduct(
  slug: string,
  signal?: AbortSignal,
): Promise<FavoriteCatalogProduct> {
  const response = await fetch(`/api/favorites/catalog/${encodeURIComponent(slug)}`, {
    signal,
    headers: marketRequestHeaders(),
  });
  if (!response.ok) throw new Error("Varianty produktu se nepodařilo načíst.");
  return response.json();
}
