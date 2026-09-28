import { describe, expect, it } from "vitest";

import {
  getActionProducts,
  getCategoryBySlug,
  getCategoryTrail,
  getFeaturedProducts,
  getHomepageFeaturedProducts,
  getCatalogStats,
  getNewProducts,
  getProducts,
  getProductBySlug,
  getProductVariantById,
  getProductsByCategory,
  getPromotionItems,
  getRecommendedProducts,
  getSaleProducts,
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

  it("uses a neutral placeholder when the feed does not provide a product image", () => {
    const productsWithoutSourceImage = getProducts().filter(
      (product) => product.imageSrc === "/akros/products/image-unavailable.svg",
    );

    expect(productsWithoutSourceImage).toHaveLength(289);
    expect(
      getProducts().some((product) => product.imageSrc === "/akros/products/product-02.jpg"),
    ).toBe(false);
  });

  it("exposes only promotion flags that are present in the source feed", () => {
    const actionProducts = getActionProducts();
    const recommendedProducts = getRecommendedProducts();
    const saleProducts = getSaleProducts();

    expect(actionProducts.length).toBeGreaterThan(0);
    expect(actionProducts.every((product) => product.isAction)).toBe(true);
    expect(recommendedProducts.length).toBeGreaterThan(0);
    expect(recommendedProducts.every((product) => product.isRecommended)).toBe(true);
    expect(saleProducts.length).toBeGreaterThan(0);
    expect(saleProducts.every((product) => product.isSale)).toBe(true);
  });

  it("provides thirty deterministic fallback novelties when the feed has none", () => {
    const newProducts = getNewProducts();

    expect(newProducts).toHaveLength(30);
    expect(newProducts.slice(0, 4).map((product) => product.id)).toEqual(
      getHomepageFeaturedProducts().map((product) => product.id),
    );
    expect(
      newProducts.every(
        (product) =>
          product.isNew &&
          product.name.trim().toLocaleUpperCase("cs-CZ") !== "AKCE" &&
          product.priceMinor > 0 &&
          product.imageSrc !== "/akros/products/image-unavailable.svg",
      ),
    ).toBe(true);
  });

  it("exposes the exact promoted variants and their source prices", () => {
    const promotedItems = getPromotionItems();
    const saleItem = promotedItems.find(
      ({ product, kind }) => product.id === "product-17994" && kind === "sale",
    );

    expect(saleItem).toMatchObject({
      kind: "sale",
      variant: {
        id: "item-6066",
        priceMinor: 8332,
        originalPriceMinor: 10_832,
        isSale: true,
      },
    });
    expect(
      promotedItems.every(({ product, variant, kind }) =>
        kind === "sale"
          ? (variant?.isSale ?? product.isSale)
          : (variant?.isAction ?? product.isAction),
      ),
    ).toBe(true);
    expect(
      promotedItems.every(({ product, variant }) => {
        const priceMinor = variant?.priceMinor ?? product.priceMinor;
        const originalPriceMinor = variant?.originalPriceMinor ?? product.originalPriceMinor;

        return originalPriceMinor === Math.round(priceMinor * 1.3);
      }),
    ).toBe(true);
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
