import type {
  CatalogCategory,
  CatalogData,
  CatalogProduct,
  CatalogPromotionItem,
  CatalogProductSummary,
  CategoryData,
} from "@/ontos/catalog-types";
import { getProductStockStatus } from "@/lib/product-stock";
import { assertCategoryForest } from "@app/merchandise/domain/category-forest";

// `localeCompare(other, "cs")` builds this collator for every comparison; sorting 2,000+ categories did that 20,000 times.
const czech = new Intl.Collator("cs");
const byPositionAndName = (left: CatalogCategory, right: CatalogCategory) =>
  left.position - right.position || czech.compare(left.name, right.name);

interface CategoryIndex {
  byId: Map<string, CatalogCategory>;
  bySlug: Map<string, CatalogCategory>;
  /** Every category by position, then Czech name. */
  sorted: CatalogCategory[];
  /** Each parent's children (`null`: the roots), in the same order. */
  children: Map<string | null, CatalogCategory[]>;
}
// The navigation tree is one array shared by every visit while it is cached (catalog-server.ts): validate, index and
// sort it once per array instead of on every catalogue model of every render.
const categoryIndexes = new WeakMap<readonly CatalogCategory[], CategoryIndex>();
const indexCategories = (categories: readonly CatalogCategory[]): CategoryIndex => {
  const held = categoryIndexes.get(categories);
  if (held !== undefined) return held;
  assertCategoryForest(categories, "projection");
  const sorted = [...categories].sort(byPositionAndName);
  const children = new Map<string | null, CatalogCategory[]>();
  for (const category of sorted) {
    const siblings = children.get(category.parentId);
    if (siblings === undefined) children.set(category.parentId, [category]);
    else siblings.push(category);
  }
  const index: CategoryIndex = {
    byId: new Map(categories.map((category) => [category.id, category] as const)),
    bySlug: new Map(categories.map((category) => [category.slug, category] as const)),
    sorted,
    children,
  };
  categoryIndexes.set(categories, index);
  return index;
};

export function createCatalog(catalogData: CatalogData, categoryData: CategoryData) {
  const {
    byId: categoriesById,
    bySlug: categoriesBySlug,
    sorted: sortedCategories,
    children: childCategories,
  } = indexCategories(categoryData.categories);
  const productsById = new Map(
    catalogData.products.map((product) => [product.id, product] as const),
  );
  const productsBySlug = new Map(
    catalogData.products.map((product) => [product.slug, product] as const),
  );

  // Listing cards carry no variant records: a group's stock comes from the owner's variant summary.
  const summarizeProductStock = (product: CatalogProduct): CatalogProductSummary["stock"] => {
    const { belowPackage, variantSummary } = product;
    const status = getProductStockStatus(product);
    if (variantSummary.count === 0) {
      return {
        kind: "quantity",
        minimumQuantity: product.minimumQuantity,
        quantityStep: product.quantityStep,
        packageQuantity: product.packageQuantity,
        status,
        stockCount: product.stockCount,
        ...(belowPackage ? { belowPackage } : {}),
        unit: product.unit,
      };
    }

    if (variantSummary.units.length !== 1) return { kind: "variants", status };

    return {
      kind: "quantity",
      minimumQuantity: product.minimumQuantity,
      status,
      stockCount: product.stockCount,
      ...(belowPackage ? { belowPackage } : {}),
      unit: variantSummary.units[0],
    };
  };

  const toProductSummary = (product: CatalogProduct): CatalogProductSummary => ({
    id: product.id,
    slug: product.slug,
    categoryId: product.categoryId,
    name: product.name,
    sku: product.sku,
    description: product.description,
    priceMinor: product.priceMinor,
    priceExcludingVatMinor: product.detail.priceTiers.find(
      (tier) => tier.priceMinor === product.priceMinor,
    )?.priceExcludingVatMinor,
    originalPriceMinor: product.originalPriceMinor,
    currency: product.currency,
    imageSrc: product.imageSrc,
    imageAlt: product.imageAlt,
    featuredPosition: product.featuredPosition,
    isAction: product.isAction,
    isRecommended: product.isRecommended,
    isSale: product.isSale,
    isNew: product.isNew,
    ...(product.availabilityUnknown ? { availabilityUnknown: true } : {}),
    ...(product.priceUnavailableReason
      ? { priceUnavailableReason: product.priceUnavailableReason }
      : {}),
    hasVariants: product.variantSummary.count > 0,
    // Only a group of several variants has no single price; one variant is a concrete item.
    priceIsFrom: product.variantSummary.count > 1,
    stock: summarizeProductStock(product),
  });

  const getCategories = (): CatalogCategory[] => [...sortedCategories];

  const getChildCategories = (parentId: string): CatalogCategory[] => [
    ...(childCategories.get(parentId) ?? []),
  ];

  const getSidebarCategories = (activeSlug?: string): CatalogCategory[] => {
    const categories: CatalogCategory[] = [];
    const includedIds = new Set<string>();
    const appendCategory = (category: CatalogCategory | undefined) => {
      if (!category || includedIds.has(category.id)) return;
      includedIds.add(category.id);
      categories.push(category);
    };

    for (const root of childCategories.get(null) ?? []) {
      appendCategory(root);
      for (const child of childCategories.get(root.id) ?? []) appendCategory(child);
    }

    const activeCategory = activeSlug ? getCategoryBySlug(activeSlug) : undefined;
    if (activeCategory) {
      const activeTrail = getCategoryTrail(activeCategory);
      if (activeTrail[0] && includedIds.has(activeTrail[0].id)) {
        for (const category of activeTrail.slice(1)) {
          appendCategory(category);
          for (const child of childCategories.get(category.id) ?? []) appendCategory(child);
        }
      }
    }

    return categories;
  };

  const getCategoryBySlug = (slug: string): CatalogCategory | undefined =>
    categoriesBySlug.get(slug);

  const getCategoryById = (id: string): CatalogCategory | undefined => categoriesById.get(id);

  const getCategoryTrail = (category: CatalogCategory): CatalogCategory[] => {
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

  const getProducts = (): CatalogProduct[] => [...catalogData.products];

  const getHomepageFeaturedProducts = (): CatalogProduct[] => {
    const configuredProducts = catalogData.homepageFeaturedProductIds.flatMap((productId) => {
      const product = productsById.get(productId);
      return product ? [product] : [];
    });
    const selectedProducts = new Map<string, CatalogProduct>();

    for (const product of [...configuredProducts, ...getRecommendedProducts()]) {
      if (product.priceMinor <= 0 || product.name.trim().toLocaleUpperCase("cs-CZ") === "AKCE") {
        continue;
      }
      selectedProducts.set(product.id, product);
      if (selectedProducts.size === 16) break;
    }

    return [...selectedProducts.values()];
  };

  const getRecommendedProducts = (): CatalogProduct[] =>
    getProducts().filter((product) => product.isRecommended);

  const getNewProducts = (): CatalogProduct[] =>
    getProducts()
      .filter((product) => product.isNew)
      .sort(
        (left, right) =>
          (left.featuredPosition ?? Number.MAX_SAFE_INTEGER) -
            (right.featuredPosition ?? Number.MAX_SAFE_INTEGER) ||
          czech.compare(left.name, right.name),
      );

  // Listing reads carry no variant records, so promotions are the owner's product-level action/sale flags.
  const getPromotionItems = (): CatalogPromotionItem[] =>
    getProducts().flatMap((product) =>
      product.isSale || product.isAction
        ? [{ product, kind: product.isSale ? ("sale" as const) : ("action" as const) }]
        : [],
    );

  const getProductById = (id: string): CatalogProduct | undefined => productsById.get(id);

  const getProductBySlug = (slug: string): CatalogProduct | undefined => productsBySlug.get(slug);

  return {
    toProductSummary,
    getCategories,
    getChildCategories,
    getSidebarCategories,
    getCategoryBySlug,
    getCategoryById,
    getCategoryTrail,
    getProducts,
    getHomepageFeaturedProducts,
    getNewProducts,
    getPromotionItems,
    getProductById,
    getProductBySlug,
  };
}
