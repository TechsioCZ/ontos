import type {
  CatalogCategory,
  CatalogData,
  CatalogMetadata,
  CatalogProduct,
  CatalogPromotionItem,
  CatalogProductSummary,
  CategoryData,
} from "./types";
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
  unit: product.unit,
  minimumQuantity: product.minimumQuantity,
  packageQuantity: product.packageQuantity,
  stockCount: product.stockCount,
  imageSrc: product.imageSrc,
  imageAlt: product.imageAlt,
  featuredPosition: product.featuredPosition,
  isAction: product.isAction,
  isRecommended: product.isRecommended,
  isSale: product.isSale,
  isNew: product.isNew,
  hasVariants: product.detail.variants.length > 0,
});

const normalizeSearchTerm = (value: string) =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("cs-CZ")
    .trim();

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

export const searchProducts = (query: string): CatalogProduct[] => {
  const normalizedQuery = normalizeSearchTerm(query);
  if (!normalizedQuery) return [];

  return getProducts().filter((product) =>
    normalizeSearchTerm(`${product.name} ${product.sku} ${product.description}`).includes(
      normalizedQuery,
    ),
  );
};
