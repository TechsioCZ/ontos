import type {
  CatalogCategory,
  CatalogData,
  CatalogProduct,
  CatalogPromotionItem,
  CatalogProductSummary,
  CategoryData,
} from "@/mock-storefront/types";
import { getProductStockStatus } from "@/lib/product-stock";

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

  // Listing cards carry no variant records: a group's stock comes from the owner's variant summary.
  const summarizeProductStock = (product: CatalogProduct): CatalogProductSummary["stock"] => {
    const { variantSummary } = product;
    if (variantSummary.count === 0) {
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

    const status = getProductStockStatus(product);
    if (variantSummary.units.length !== 1) return { kind: "variants", status };

    return {
      kind: "quantity",
      minimumQuantity: product.minimumQuantity,
      status,
      stockCount: product.stockCount,
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
    priceIsFrom: product.variantSummary.count > 0,
    stock: summarizeProductStock(product),
  });

  const getCategories = (): CatalogCategory[] =>
    [...categoryData.categories].sort(
      (left, right) => left.position - right.position || left.name.localeCompare(right.name, "cs"),
    );

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
          left.name.localeCompare(right.name, "cs"),
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
