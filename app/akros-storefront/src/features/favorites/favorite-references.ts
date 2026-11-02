/** Browser-local favorites (by design: no OntOS favorites backend); the storage key keeps its demo name. */
export const favoritesStorageKey = "akros-demo-favorites-v1";
export {
  parseVariantReferences as parseFavorites,
  replaceProductReferences as replaceProductFavorites,
  type ProductVariantReference as FavoriteReference,
} from "@/features/products/variant-references";
