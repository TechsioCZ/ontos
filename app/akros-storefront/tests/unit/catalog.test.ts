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
  getSidebarCategories,
  searchCatalog,
  searchProducts,
  toProductSummary,
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

  it("returns the published sidebar categories in the live navigation order", () => {
    const categories = getSidebarCategories();
    const roots = categories.filter((category) => category.parentId === null);
    const fasteners = roots.find((category) => category.slug === "nerezovy-spojovaci-material");
    const steel = roots.find((category) => category.slug === "nerezovy-hutni-material");

    expect(roots.map((category) => category.slug)).toEqual([
      "nerezovy-spojovaci-material",
      "nerezovy-hutni-material",
    ]);
    expect(
      categories.filter((category) => category.parentId === fasteners?.id).map(({ slug }) => slug),
    ).toEqual([
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
    ]);
    expect(
      categories.filter((category) => category.parentId === steel?.id).map(({ slug }) => slug),
    ).toEqual([
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
    ]);
    expect(categories.some((category) => category.slug === "specialni-spojovaci-material")).toBe(
      false,
    );
  });

  it("returns the generated homepage selection in its configured display order", () => {
    const featured = getFeaturedProducts();

    expect(featured).toHaveLength(4);
    expect(featured.map((product) => product.featuredPosition)).toEqual([1, 2, 3, 4]);
  });

  it("returns sixteen distinct purchasable homepage products backed by source records", () => {
    const homepageProducts = getHomepageFeaturedProducts();

    expect(homepageProducts).toHaveLength(16);
    expect(new Set(homepageProducts.map((product) => product.id)).size).toBe(16);
    expect(homepageProducts.every((product) => product.priceMinor > 0)).toBe(true);
    expect(homepageProducts.slice(0, 4).map((product) => product.id)).toEqual(
      getFeaturedProducts().map((product) => product.id),
    );
    expect(homepageProducts.slice(4).every((product) => product.isRecommended)).toBe(true);
    expect(homepageProducts.some((product) => product.name.trim() === "AKCE")).toBe(false);
    expect(homepageProducts.map((product) => getProductBySlug(product.slug))).toEqual(
      homepageProducts,
    );
    expect(getHomepageFeaturedProducts()).toEqual(homepageProducts);
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
      getHomepageFeaturedProducts()
        .slice(0, 4)
        .map((product) => product.id),
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
        const originalPriceMinor = variant?.originalPriceMinor ?? product.originalPriceMinor;

        return originalPriceMinor === undefined;
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

  it("finds a concrete purchasing variant by its source SKU", () => {
    const results = searchCatalog("10799700050025");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      product: {
        slug: "vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
      },
      matchingVariants: [
        {
          id: "item-4709",
          sku: "10799700050025",
        },
      ],
    });
  });

  it("searches variant parameters from the feed without duplicating product families", () => {
    const results = searchCatalog("l=40mm");
    const doubleNipple = results.find(
      ({ product }) => product.slug === "dvojniply-typ-310-mat-1-4404",
    );

    expect(doubleNipple?.matchingVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sku: "3dn31028000000010",
        }),
      ]),
    );
    expect(new Set(results.map(({ product }) => product.id)).size).toBe(results.length);
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
      packageQuantity: 1000,
      priceMinor: 100,
      stockCount: 880,
    });
  });

  it("preserves decimal purchasing quantities from the source feed", () => {
    const profiles = getProductBySlug("profilovana-stresni-krytina-product-35919");
    const profile = profiles?.detail.variants.find((variant) => variant.sku === "10SOLTS1004000");
    const tubes = getProductBySlug("trubky-kruhove-svarovane-mat-1-4301");
    const tube = tubes?.detail.variants.find((variant) => variant.sku === "3trks021000054015");

    expect(profile).toMatchObject({
      minimumQuantity: 4.5,
      packageQuantity: 30,
      stockCount: 45,
      unit: "m",
    });
    expect(tube).toMatchObject({
      minimumQuantity: 0.5,
      stockCount: 13.5,
      unit: "m",
    });
    expect(tube?.packageQuantity).toBeUndefined();
  });

  it("summarizes compatible variant stock without hiding the varying price", () => {
    const product = getProductBySlug("vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2");

    expect(product && toProductSummary(product)).toMatchObject({
      priceIsFrom: true,
      stock: {
        kind: "quantity",
        status: "in-stock",
        stockCount: 9903,
        unit: "ks",
      },
    });
  });

  it("does not add stock from variants with incompatible units", () => {
    const product = getProductBySlug("profilovana-stresni-krytina-product-35919");

    expect(product && toProductSummary(product)).toMatchObject({
      priceIsFrom: true,
      stock: {
        kind: "variants",
        status: "in-stock",
      },
    });
  });
});
