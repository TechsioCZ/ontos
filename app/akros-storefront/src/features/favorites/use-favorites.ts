"use client";

import {
  replaceStoredProductReferences,
  useVariantReferences,
} from "@/features/products/use-variant-references";
import { favoritesStorageKey, type FavoriteReference } from "@/mock-storefront/favorites";

export function saveProductFavorites(productId: string, selected: FavoriteReference[]) {
  replaceStoredProductReferences(favoritesStorageKey, productId, selected);
}
export function useFavorites() {
  const { references, ...state } = useVariantReferences(favoritesStorageKey);
  return { favorites: references, ...state };
}
