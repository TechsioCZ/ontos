import type { CatalogProductSummary, CatalogProductVariant } from "@/ontos/catalog-types";

export interface FavoriteCatalogProduct {
  product: CatalogProductSummary;
  variants: CatalogProductVariant[];
}

export async function loadFavoriteProduct(
  slug: string,
  signal?: AbortSignal,
): Promise<FavoriteCatalogProduct> {
  const response = await fetch(`/api/favorites/catalog/${encodeURIComponent(slug)}`, { signal });
  if (!response.ok) throw new Error("Varianty produktu se nepodařilo načíst.");
  return response.json();
}
