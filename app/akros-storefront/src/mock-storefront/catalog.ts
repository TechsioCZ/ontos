// Kai's prototype remains the default; live requests use the same pure model with OntOS data.
import { createCatalog } from "@/ontos/catalog-model";
import rawCatalogData from "./generated/catalog.generated.json";
import rawCategoryData from "./generated/categories.generated.json";
import type { CatalogData, CategoryData } from "./types";
export const {
  toProductSummary,
  getCategories,
  getTopCategories,
  getChildCategories,
  getSidebarCategories,
  getCategoryBySlug,
  getCategoryById,
  getCategoryTrail,
  getCatalogStats,
  getProducts,
  getFeaturedProducts,
  getHomepageFeaturedProducts,
  getActionProducts,
  getRecommendedProducts,
  getNewProducts,
  getSaleProducts,
  getPromotionItems,
  getProductById,
  getProductVariantById,
  getProductUnitPrice,
  getProductBySlug,
  getProductsByCategory,
  searchCatalog,
  searchProducts,
} = createCatalog(rawCatalogData as CatalogData, rawCategoryData as CategoryData);
