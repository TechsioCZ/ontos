import { describe, expect, it } from "vitest";

import {
  getCategoryBySlug,
  getCategoryTrail,
  getFeaturedProducts,
  getHomepageFeaturedProducts,
  getCatalogStats,
  getProductBySlug,
  getProductVariantById,
  getProductsByCategory,
  searchProducts,
} from "@/mock-storefront/catalog";

describe("mock catalog gateway", () => {
  it("exposes every category and product item from the static Akros feed", () => {
    expect(getCatalogStats()).toMatchObject({
      sourceCategoryCount: 2125,
      sourceItemCount: 20_304,
      productGroupCount: 1289,
    });
  });

  it("models the DIN 7997 family with its complete source variants and category trail", () => {
    const product = getProductBySlug("vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2");

    expect(product?.detail?.variants).toHaveLength(47);
    expect(product?.detail?.variants).toContainEqual(
      expect.objectContaining({
        sku: "10799700040040",
        stockCount: 109,
        priceMinor: 175,
      }),
    );

    expect(
      product && getCategoryTrail(getCategoryBySlug("a-2-141")!).map((category) => category.slug),
    ).toEqual(["nerezovy-spojovaci-material", "vruty", "vruty-do-dreva", "din-7997", "a-2-141"]);
  });

  it("returns the generated homepage selection in its configured display order", () => {
    const featured = getFeaturedProducts();

    expect(featured).toHaveLength(4);
    expect(featured.map((product) => product.featuredPosition)).toEqual([1, 2, 3, 4]);
  });

  it("returns four purchasable homepage products backed by source records", () => {
    const homepageProducts = getHomepageFeaturedProducts();

    expect(homepageProducts).toHaveLength(4);
    expect(homepageProducts.every((product) => product.priceMinor > 0)).toBe(true);
    expect(homepageProducts.map((product) => product.id)).toEqual(
      getFeaturedProducts().map((product) => product.id),
    );
  });

  it("finds products in a category including nested descendants", () => {
    const products = getProductsByCategory("nerezovy-spojovaci-material");

    expect(products.map((product) => product.slug)).toContain(
      "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
    );
  });

  it("searches case-insensitively and ignores Czech diacritics", () => {
    expect(searchProducts("SROUBY S SESTIHRANNOU").map((product) => product.slug)).toContain(
      "srouby-se-sestihrannou-hlavou-din-933-a2",
    );
  });

  it("resolves categories by their public slug", () => {
    expect(getCategoryBySlug("srouby")?.name).toBe("Šrouby");
  });

  it("marks categories that have visible child categories", () => {
    expect(getCategoryBySlug("koliky")?.hasChildren).toBe(true);
    expect(getCategoryBySlug("a-2-141")?.hasChildren).toBe(false);
  });

  it("resolves a source purchasing variant for the DIN 933 product", () => {
    const product = getProductBySlug("srouby-se-sestihrannou-hlavou-din-933-a2");
    const variant = getProductVariantById("product-16800", "item-1411");

    expect(product?.detail?.variants).toHaveLength(350);
    expect(variant).toMatchObject({
      sku: "10093300040016",
      minimumQuantity: 10,
      priceMinor: 100,
      stockCount: 880,
    });
  });
});
