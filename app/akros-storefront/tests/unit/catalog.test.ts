import { describe, expect, it } from "vitest";

import { fixtureCatalog } from "../support/catalog-fixture";

const {
  getCategoryBySlug,
  getCategoryTrail,
  getHomepageFeaturedProducts,
  getProductBySlug,
  getSidebarCategories,
  toProductSummary,
} = fixtureCatalog;

describe("catalog model", () => {
  it("resolves a category trail from the navigation tree", () => {
    expect(
      getCategoryTrail(getCategoryBySlug("a-2-141")!).map((category) => category.slug),
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

  it("returns sixteen distinct purchasable homepage products backed by source records", () => {
    const homepageProducts = getHomepageFeaturedProducts();

    expect(homepageProducts).toHaveLength(16);
    expect(new Set(homepageProducts.map((product) => product.id)).size).toBe(16);
    expect(homepageProducts.every((product) => product.priceMinor > 0)).toBe(true);
    expect(homepageProducts.slice(0, 4).map((product) => product.featuredPosition)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(homepageProducts.slice(4).every((product) => product.isRecommended)).toBe(true);
    expect(homepageProducts.some((product) => product.name.trim() === "AKCE")).toBe(false);
    expect(homepageProducts.map((product) => getProductBySlug(product.slug))).toEqual(
      homepageProducts,
    );
    expect(getHomepageFeaturedProducts()).toEqual(homepageProducts);
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
