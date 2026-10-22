// Test fixture: Kai's generated AKROS catalog (the OntOS seed input) in the storefront model shape.
import { createCatalog } from "@/ontos/catalog-model";
import rawCatalog from "@/mock-storefront/generated/catalog.generated.json";
import rawCategories from "@/mock-storefront/generated/categories.generated.json";
import type { CatalogCategory, CatalogProduct } from "@/mock-storefront/types";

type SeedProduct = Omit<CatalogProduct, "variantSummary">;

/** The owner's `variantSummary` for a seed product (active, priced variants). */
const withVariantSummary = (product: SeedProduct): CatalogProduct => {
  const priced = product.detail.variants.filter((variant) => variant.priceMinor > 0);
  return {
    ...product,
    variantSummary: {
      count: priced.length,
      minGrossPriceMinor: priced.length
        ? Math.min(...priced.map((variant) => variant.priceMinor))
        : null,
      stockOnHand: priced.reduce((sum, variant) => sum + variant.stockCount, 0),
      units: [...new Set(priced.map((variant) => variant.unit))].sort(),
    },
  };
};

export const fixtureProducts = (rawCatalog.products as unknown as SeedProduct[]).map(
  withVariantSummary,
);
export const fixtureCategories = rawCategories.categories as CatalogCategory[];
export const fixtureCatalog = createCatalog(
  { products: fixtureProducts, homepageFeaturedProductIds: rawCatalog.homepageFeaturedProductIds },
  { categories: fixtureCategories },
);

/** What an OntOS `categorySlug` read returns: products of the category and its descendants. */
export const fixtureCategoryProducts = (slug: string): CatalogProduct[] => {
  const root = fixtureCatalog.getCategoryBySlug(slug);
  if (!root) return [];
  const ids = new Set([root.id]);
  for (let size = 0; size !== ids.size;) {
    size = ids.size;
    for (const category of fixtureCategories)
      if (category.parentId && ids.has(category.parentId)) ids.add(category.id);
  }
  return fixtureProducts.filter((product) => ids.has(product.categoryId));
};

/** A listing card: the owner sends no variant records, parameters or description paragraphs. */
export const asCard = (product: CatalogProduct): CatalogProduct => ({
  ...product,
  detail: { ...product.detail, descriptionParagraphs: [], parameters: [], variants: [] },
});
