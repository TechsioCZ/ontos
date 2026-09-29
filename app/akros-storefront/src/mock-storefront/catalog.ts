import type {
  CatalogCategory,
  CatalogData,
  CatalogMetadata,
  CatalogProduct,
  CatalogPromotionItem,
  CatalogProductSummary,
  CatalogSearchResult,
  CategoryData,
} from "./types";
import {
  formatCatalogParametersForSearch,
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import { getProductStockStatus, type ProductStockStatus } from "@/lib/product-stock";
import rawCatalogData from "./generated/catalog.generated.json";
import rawCategoryData from "./generated/categories.generated.json";

const catalogData = rawCatalogData as CatalogData;
const categoryData = rawCategoryData as CategoryData;
const categoriesById = new Map(
  categoryData.categories.map((category) => [category.id, category] as const),
);
const categoriesBySlug = new Map(
  categoryData.categories.map((category) => [category.slug, category] as const),
);
const productsById = new Map(catalogData.products.map((product) => [product.id, product] as const));
const productsBySlug = new Map(
  catalogData.products.map((product) => [product.slug, product] as const),
);

const getVariantGroupStockStatus = (
  variants: CatalogProduct["detail"]["variants"],
): ProductStockStatus => {
  const statuses = variants.map(getProductStockStatus);
  if (statuses.includes("in-stock")) return "in-stock";
  if (statuses.includes("limited-stock")) return "limited-stock";
  return "out-of-stock";
};

const summarizeProductStock = (product: CatalogProduct): CatalogProductSummary["stock"] => {
  const { variants } = product.detail;
  if (variants.length === 0) {
    return {
      kind: "quantity",
      minimumQuantity: product.minimumQuantity,
      packageQuantity: product.packageQuantity,
      status: getProductStockStatus(product),
      stockCount: product.stockCount,
      unit: product.unit,
    };
  }

  const status = getVariantGroupStockStatus(variants);
  const units = new Set(variants.map((variant) => variant.unit));
  if (units.size !== 1) return { kind: "variants", status };

  return {
    kind: "quantity",
    minimumQuantity: Math.min(...variants.map((variant) => variant.minimumQuantity)),
    status,
    stockCount: variants.reduce((total, variant) => total + variant.stockCount, 0),
    unit: variants[0].unit,
  };
};

export const toProductSummary = (product: CatalogProduct): CatalogProductSummary => ({
  id: product.id,
  slug: product.slug,
  categoryId: product.categoryId,
  name: product.name,
  sku: product.sku,
  description: product.description,
  priceMinor: product.priceMinor,
  originalPriceMinor: product.originalPriceMinor,
  currency: product.currency,
  imageSrc: product.imageSrc,
  imageAlt: product.imageAlt,
  featuredPosition: product.featuredPosition,
  isAction: product.isAction,
  isRecommended: product.isRecommended,
  isSale: product.isSale,
  isNew: product.isNew,
  hasVariants: product.detail.variants.length > 0,
  priceIsFrom: product.detail.variants.length > 0,
  stock: summarizeProductStock(product),
});

const collectCategoryIds = (categoryId: string): Set<string> => {
  const ids = new Set([categoryId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const category of categoryData.categories) {
      if (category.parentId && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        changed = true;
      }
    }
  }

  return ids;
};

export const getCategories = (): CatalogCategory[] =>
  [...categoryData.categories].sort(
    (left, right) => left.position - right.position || left.name.localeCompare(right.name, "cs"),
  );

export const getTopCategories = (): CatalogCategory[] =>
  getCategories().filter((category) => category.parentId === null);

export const getChildCategories = (parentId: string): CatalogCategory[] =>
  getCategories().filter((category) => category.parentId === parentId);

export const getSidebarCategories = (activeSlug?: string): CatalogCategory[] => {
  const preferredRootIds = new Set(["26", "1223", "1369"]);
  const preferredRoots = getTopCategories().filter((category) => preferredRootIds.has(category.id));
  const topCategories = preferredRoots.length > 0 ? preferredRoots : getTopCategories();
  const includedIds = new Set(topCategories.map((category) => category.id));

  for (const category of topCategories) {
    for (const child of getChildCategories(category.id)) includedIds.add(child.id);
  }

  const activeCategory = activeSlug ? getCategoryBySlug(activeSlug) : undefined;
  if (activeCategory) {
    for (const category of getCategoryTrail(activeCategory)) {
      includedIds.add(category.id);
      for (const child of getChildCategories(category.id)) includedIds.add(child.id);
    }
  }

  return getCategories().filter((category) => includedIds.has(category.id));
};

export const getCategoryBySlug = (slug: string): CatalogCategory | undefined =>
  categoriesBySlug.get(slug);

export const getCategoryById = (id: string): CatalogCategory | undefined => categoriesById.get(id);

export const getCategoryTrail = (category: CatalogCategory): CatalogCategory[] => {
  const trail: CatalogCategory[] = [category];
  let parentId = category.parentId;

  while (parentId) {
    const parent = categoriesById.get(parentId);
    if (!parent) break;
    trail.unshift(parent);
    parentId = parent.parentId;
  }

  return trail;
};

export const getCatalogStats = (): CatalogMetadata => ({ ...catalogData.metadata });

export const getProducts = (): CatalogProduct[] => [...catalogData.products];

export const getFeaturedProducts = (): CatalogProduct[] =>
  getProducts()
    .filter((product) => product.featuredPosition !== null)
    .sort(
      (left, right) =>
        (left.featuredPosition ?? Number.MAX_SAFE_INTEGER) -
        (right.featuredPosition ?? Number.MAX_SAFE_INTEGER),
    );

export const getHomepageFeaturedProducts = (): CatalogProduct[] =>
  catalogData.homepageFeaturedProductIds.flatMap((productId) => {
    const product = productsById.get(productId);
    return product ? [product] : [];
  });

export const getActionProducts = (): CatalogProduct[] =>
  getProducts().filter((product) => product.isAction);

export const getRecommendedProducts = (): CatalogProduct[] =>
  getProducts().filter((product) => product.isRecommended);

export const getNewProducts = (): CatalogProduct[] =>
  getProducts()
    .filter((product) => product.isNew)
    .sort(
      (left, right) =>
        (left.featuredPosition ?? Number.MAX_SAFE_INTEGER) -
          (right.featuredPosition ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name, "cs"),
    );

export const getSaleProducts = (): CatalogProduct[] =>
  getProducts().filter((product) => product.isSale);

export const getPromotionItems = (): CatalogPromotionItem[] =>
  getProducts().flatMap((product) => {
    const promotedVariants = product.detail.variants.flatMap((variant) => {
      if (!variant.isSale && !variant.isAction) return [];

      return [
        {
          product,
          variant,
          kind: variant.isSale ? ("sale" as const) : ("action" as const),
        },
      ];
    });

    if (promotedVariants.length > 0) return promotedVariants;
    if (product.detail.variants.length > 0 || (!product.isSale && !product.isAction)) return [];

    return [
      {
        product,
        kind: product.isSale ? ("sale" as const) : ("action" as const),
      },
    ];
  });

export const getProductById = (id: string): CatalogProduct | undefined => productsById.get(id);

export const getProductVariantById = (productId: string, variantId?: string) =>
  variantId
    ? getProductById(productId)?.detail?.variants.find((variant) => variant.id === variantId)
    : undefined;

export const getProductUnitPrice = (productId: string, variantId?: string): number | undefined => {
  const product = getProductById(productId);
  if (!product) return undefined;

  return getProductVariantById(productId, variantId)?.priceMinor ?? product.priceMinor;
};

export const getProductBySlug = (slug: string): CatalogProduct | undefined =>
  productsBySlug.get(slug);

export const getProductsByCategory = (slug: string): CatalogProduct[] => {
  const category = getCategoryBySlug(slug);
  if (!category) return [];

  const categoryIds = collectCategoryIds(category.id);
  return getProducts().filter((product) => categoryIds.has(product.categoryId));
};

export const searchCatalog = (query: string): CatalogSearchResult[] => {
  const normalizedQuery = normalizeCatalogSearchTerm(query);
  if (!normalizedQuery) return [];

  return getProducts().flatMap((product) => {
    const productMatches = normalizeCatalogSearchTerm(
      `${product.name} ${product.sku} ${product.description} ${formatCatalogParametersForSearch(product.detail.parameters)}`,
    ).includes(normalizedQuery);
    const matchingVariants = product.detail.variants.filter((variant) =>
      matchesProductVariantSearch(variant, normalizedQuery),
    );
    const exactSkuMatch = matchingVariants.find(
      (variant) => normalizeCatalogSearchTerm(variant.sku) === normalizedQuery,
    );

    if (exactSkuMatch) return [{ product, matchingVariants: [exactSkuMatch] }];
    if (productMatches) return [{ product, matchingVariants: [] }];
    if (matchingVariants.length > 0) return [{ product, matchingVariants }];
    return [];
  });
};

export const searchProducts = (query: string): CatalogProduct[] =>
  searchCatalog(query).map(({ product }) => product);
