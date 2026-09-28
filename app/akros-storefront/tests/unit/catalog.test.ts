import { describe, expect, it } from "vitest";

import {
  getCategoryBySlug,
  getFeaturedProducts,
  getHomepageFeaturedProducts,
  getProductBySlug,
  getProductVariantById,
  getProductsByCategory,
  searchProducts,
} from "@/mock-storefront/catalog";

describe("mock catalog gateway", () => {
  it("returns featured products in their configured display order", () => {
    expect(getFeaturedProducts().map((product) => product.slug)).toEqual([
      "vrut-univerzalni-se-zapustnou-hlavou",
      "matice-sestihranna-m8-din-934-a2",
      "podlozka-plocha-m8-din-125a-a2",
      "nerezove-lano-7x7",
      "nerezovy-retez-din-766-a4",
      "nerezova-kulatina-aisi-304",
    ]);
  });

  it("returns the four homepage products in their Figma display order", () => {
    expect(getHomepageFeaturedProducts().map((product) => product.slug)).toEqual([
      "vrut-univerzalni-se-zapustnou-hlavou",
      "nerezove-lano-7x7",
      "nerezovy-retez-din-766-a4",
      "nerezova-kulatina-aisi-304",
    ]);
  });

  it("finds products in a category including nested descendants", () => {
    const products = getProductsByCategory("nerezovy-spojovaci-material");

    expect(products.map((product) => product.slug)).toContain(
      "vrut-univerzalni-se-zapustnou-hlavou",
    );
  });

  it("searches case-insensitively and ignores Czech diacritics", () => {
    expect(searchProducts("NEREZOVE LANO").map((product) => product.slug)).toEqual([
      "nerezove-lano-7x7",
    ]);
  });

  it("resolves categories by their public slug", () => {
    expect(getCategoryBySlug("srouby")?.name).toBe("Šrouby");
  });

  it("resolves the mock purchasing variants configured for the DIN 933 product", () => {
    const product = getProductBySlug("srouby-se-sestihrannou-hlavou-din-933-a2");
    const variant = getProductVariantById("product-hex-bolt", "hex-bolt-m4x16");

    expect(product?.detail?.variants).toHaveLength(5);
    expect(variant).toMatchObject({
      label: "M 4 × 16",
      packageQuantity: 500,
      priceMinor: 194,
    });
  });
});
