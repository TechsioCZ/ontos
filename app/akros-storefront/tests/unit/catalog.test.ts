import { describe, expect, it } from "vitest";
import { createCatalog } from "@/ontos/catalog-model";

import { matchSearchVariants, searchHitPath } from "@/ontos/search-suggestions";
import { fixtureCatalog, fixtureProducts } from "../support/catalog-fixture";

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

  it("lists arbitrary published roots and children in owner position order", () => {
    const node = (id: string, parentId: string | null, position: number) => ({
      id,
      parentId,
      position,
      slug: id,
      name: id,
      hasChildren: false,
    });
    const model = createCatalog(
      { products: [], homepageFeaturedProductIds: [] },
      {
        categories: [
          node("new-child-b", "new-root", 2),
          node("other-root", null, 2),
          node("new-root", null, 1),
          node("new-child-a", "new-root", 1),
          node("new-leaf", "new-child-a", 1),
        ],
      },
    );
    expect(model.getSidebarCategories().map(({ id }) => id)).toEqual([
      "new-root",
      "new-child-a",
      "new-child-b",
      "other-root",
    ]);
    expect(model.getSidebarCategories("new-child-a").map(({ id }) => id)).toEqual([
      "new-root",
      "new-child-a",
      "new-child-b",
      "other-root",
      "new-leaf",
    ]);
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

  it("shows a price for a single-variant group, but not a lower bound for several variants", () => {
    const single = fixtureProducts.find((product) => product.variantSummary.count === 1)!;
    const group = fixtureProducts.find((product) => product.variantSummary.count > 1)!;
    expect(toProductSummary(single)).toMatchObject({ hasVariants: true, priceIsFrom: false });
    expect(toProductSummary(group)).toMatchObject({ hasVariants: true, priceIsFrom: true });
  });
});

describe("search variant routing", () => {
  const match = (slug: string, query: string) =>
    matchSearchVariants(getProductBySlug(slug)!, query).matching.map((variant) => variant.id);

  it("keeps an exact SKU distinct from a longer SKU with the same prefix", () => {
    expect(match("matice-nytovaci-se-zapustnou-hlavou-an-1972-a2", "10197200040300")).toEqual([
      "item-9025",
    ]);
  });

  it("preserves all exact variants when the source reuses a SKU", () => {
    expect(match("dvojniply-typ-310-mat-1-4404", "3dn31028000000025").sort()).toEqual([
      "item-2238",
      "item-37855",
    ]);
  });

  it("needs no variant when the product itself matches", () => {
    const product = getProductBySlug("vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2")!;
    expect(matchSearchVariants(product, product.name).matching).toEqual([]);
  });

  it("links one hit exactly, several hits through the query filter and no hit to the product", () => {
    const one = { matching: [{ id: "item-9025" }] } as Parameters<typeof searchHitPath>[3];
    const two = { matching: [{ id: "a" }, { id: "b" }] } as Parameters<typeof searchHitPath>[3];
    expect(searchHitPath("matice", "1019", true, one)).toBe(
      "/produkt/matice?variantIds=item-9025#product-variants",
    );
    expect(searchHitPath("matice", " M6 ", true, two)).toBe(
      "/produkt/matice?variant=M6#product-variants",
    );
    expect(searchHitPath("matice", "M6", true, { matching: [] })).toBe("/produkt/matice");
    expect(searchHitPath("matice", "M6", true)).toBe("/produkt/matice?variant=M6#product-variants");
    expect(searchHitPath("matice", "M6", false)).toBe("/produkt/matice");
  });
});
