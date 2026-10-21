import type {
  CatalogCategory,
  CatalogData,
  CatalogMetadata,
  CatalogProduct,
  CatalogPromotionItem,
  CatalogProductSummary,
  CatalogSearchResult,
  CategoryData,
} from "@/mock-storefront/types";
import {
  formatCatalogParametersForSearch,
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import { getProductStockStatus, type ProductStockStatus } from "@/lib/product-stock";

export function createCatalog(catalogData: CatalogData, categoryData: CategoryData) {
  const categoriesById = new Map(
    categoryData.categories.map((category) => [category.id, category] as const),
  );
  const categoriesBySlug = new Map(
    categoryData.categories.map((category) => [category.slug, category] as const),
  );
  const productsById = new Map(
    catalogData.products.map((product) => [product.id, product] as const),
  );
  const productsBySlug = new Map(
    catalogData.products.map((product) => [product.slug, product] as const),
  );

  const sidebarCategoryOrder = [
    {
      slug: "nerezovy-spojovaci-material",
      children: [
        "srouby",
        "matice",
        "podlozky",
        "zavitove-tyce-a-svorniky",
        "vruty",
        "koliky",
        "nyty",
        "bezpecnostni-srouby-a-vruty",
        "ostatni-spojovaci-material",
        "lanaretezypantyjachtdopln",
        "kotevni-technikalepidla",
        "naradi-a-prislusenstvi",
        "maziva",
        "solar-system",
        "nerez-cerny-design",
      ],
    },
    {
      slug: "nerezovy-hutni-material",
      children: [
        "plechy",
        "trubky",
        "profily",
        "tyce",
        "kolena",
        "priruby",
        "armatury-1",
        "potravinarske-armatury",
        "prislusenstvi",
        "mazaci-hlavice",
        "matice-km-a-podlozky-mb",
      ],
    },
  ] as const;

  const getVariantGroupStockStatus = (
    variants: CatalogProduct["detail"]["variants"],
  ): ProductStockStatus => {
    const statuses = variants.map(getProductStockStatus);
    if (statuses.includes("in-stock")) return "in-stock";
    if (statuses.includes("limited-stock")) return "limited-stock";
    if (statuses.includes("unknown")) return "unknown";
    return "out-of-stock";
  };

  const summarizeProductStock = (product: CatalogProduct): CatalogProductSummary["stock"] => {
    const { variants } = product.detail;
    if (variants.length === 0) {
      return {
        kind: "quantity",
        minimumQuantity: product.minimumQuantity,
        quantityStep: product.quantityStep,
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

  const getCategories = (): CatalogCategory[] =>
    [...categoryData.categories].sort(
      (left, right) => left.position - right.position || left.name.localeCompare(right.name, "cs"),
    );

  const getTopCategories = (): CatalogCategory[] =>
    getCategories().filter((category) => category.parentId === null);

  const getChildCategories = (parentId: string): CatalogCategory[] =>
    getCategories().filter((category) => category.parentId === parentId);

  const getSidebarCategories = (activeSlug?: string): CatalogCategory[] => {
    const categories: CatalogCategory[] = [];
    const includedIds = new Set<string>();
    const appendCategory = (category: CatalogCategory | undefined) => {
      if (!category || includedIds.has(category.id)) return;
      includedIds.add(category.id);
      categories.push(category);
    };

    for (const section of sidebarCategoryOrder) {
      const rootCategory = getCategoryBySlug(section.slug);
      appendCategory(rootCategory);
      if (!rootCategory) continue;

      for (const childSlug of section.children) {
        const child = getCategoryBySlug(childSlug);
        if (child?.parentId === rootCategory.id) appendCategory(child);
      }
    }

    const activeCategory = activeSlug ? getCategoryBySlug(activeSlug) : undefined;
    if (activeCategory) {
      const activeTrail = getCategoryTrail(activeCategory);
      if (activeTrail[0] && includedIds.has(activeTrail[0].id)) {
        for (const category of activeTrail.slice(1)) {
          appendCategory(category);
          for (const child of getChildCategories(category.id)) appendCategory(child);
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

  const getCatalogStats = (): CatalogMetadata => ({ ...catalogData.metadata });

  const getProducts = (): CatalogProduct[] => [...catalogData.products];

  const getFeaturedProducts = (): CatalogProduct[] =>
    getProducts()
      .filter((product) => product.featuredPosition !== null)
      .sort(
        (left, right) =>
          (left.featuredPosition ?? Number.MAX_SAFE_INTEGER) -
          (right.featuredPosition ?? Number.MAX_SAFE_INTEGER),
      );

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

  const getActionProducts = (): CatalogProduct[] =>
    getProducts().filter((product) => product.isAction);

  const getRecommendedProducts = (): CatalogProduct[] =>
    getProducts().filter((product) => product.isRecommended);

  const getNewProducts = (): CatalogProduct[] =>
    getProducts()
      .filter((product) => product.isNew)
      .sort(
        (left, right) =>
          (left.featuredPosition ?? Number.MAX_SAFE_INTEGER) -
            (right.featuredPosition ?? Number.MAX_SAFE_INTEGER) ||
          left.name.localeCompare(right.name, "cs"),
      );

  const getSaleProducts = (): CatalogProduct[] => getProducts().filter((product) => product.isSale);

  const getPromotionItems = (): CatalogPromotionItem[] =>
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

  const getProductById = (id: string): CatalogProduct | undefined => productsById.get(id);

  const getProductVariantById = (productId: string, variantId?: string) =>
    variantId
      ? getProductById(productId)?.detail?.variants.find((variant) => variant.id === variantId)
      : undefined;

  const getProductUnitPrice = (productId: string, variantId?: string): number | undefined => {
    const product = getProductById(productId);
    if (!product) return undefined;

    return getProductVariantById(productId, variantId)?.priceMinor ?? product.priceMinor;
  };

  const getProductBySlug = (slug: string): CatalogProduct | undefined => productsBySlug.get(slug);

  const getProductsByCategory = (slug: string): CatalogProduct[] => {
    const category = getCategoryBySlug(slug);
    if (!category) return [];

    const categoryIds = collectCategoryIds(category.id);
    return getProducts().filter((product) => categoryIds.has(product.categoryId));
  };

  const searchCatalog = (query: string): CatalogSearchResult[] => {
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

  const searchProducts = (query: string): CatalogProduct[] =>
    searchCatalog(query).map(({ product }) => product);

  return {
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
  };
}
