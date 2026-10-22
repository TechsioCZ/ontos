import { describe, expect, it } from "vitest";
import {
  buildVariantDetailHref,
  buildVariantQuestionHref,
  buildVariantSelectionHref,
  parseVariantIds,
  resolveVariantSelection,
} from "@/lib/product-variant-links";
import { getProducts } from "@/mock-storefront/catalog";

describe("exact variant selection URLs", () => {
  it("opens and closes one detail without changing the shared selection or search", () => {
    const current = "variantIds=item-1%2Citem-2&variant=M6";
    const opened = new URL(
      buildVariantDetailHref("vruty", "item-2", current),
      "https://example.test",
    );
    expect(opened.searchParams.get("variantDetail")).toBe("item-2");
    expect(opened.searchParams.get("variantIds")).toBe("item-1,item-2");
    expect(opened.searchParams.get("variant")).toBe("M6");
    expect(buildVariantDetailHref("vruty", null, opened.search)).toBe(
      `/produkt/vruty?${current}#product-variants`,
    );
  });
  it("retains variant content from the feed without inventing a weight unit", () => {
    const variant = getProducts()
      .flatMap((item) => item.detail.variants)
      .find((item) => item.sku === "10799700050025")!;
    expect(variant.description?.length).toBeGreaterThan(0);
    expect(variant.description).not.toMatch(/<[^>]+>/);
    expect(variant.sourceNetWeight).toBe(0.0034);
    expect(variant).not.toHaveProperty("netWeight");
  });
  it("round-trips multiple IDs independently of free text and deduplicates them", () => {
    const product = getProducts().find((item) => item.detail.variants.length > 2)!;
    const [a, b] = product.detail.variants;
    const url = new URL(
      buildVariantSelectionHref(product.slug, [a.id, b.id, a.id]),
      "https://example.test",
    );
    expect(
      resolveVariantSelection(
        product.detail.variants,
        url.searchParams.get("variantIds") ?? undefined,
      ).map((item) => item.id),
    ).toEqual([a.id, b.id]);
    expect(parseVariantIds([`${a.id},${b.id}`, a.id])).toEqual([a.id, b.id]);
    expect(resolveVariantSelection(product.detail.variants, "no-such-id")).toEqual([]);
  });
  it("keeps the largest catalog selection below a normal URL size budget", () => {
    const largest = [...getProducts()].sort(
      (a, b) => b.detail.variants.length - a.detail.variants.length,
    )[0];
    expect(
      buildVariantSelectionHref(
        largest.slug,
        largest.detail.variants.map((item) => item.id),
      ).length,
    ).toBeLessThan(7000);
  });
  it("links questions to the selected product without putting customer text in the URL", () => {
    expect(buildVariantQuestionHref("vruty", ["item-1", "item-2"])).toBe(
      "/kontakty?product=vruty&variantIds=item-1%2Citem-2#primy-kontakt",
    );
    expect(buildVariantSelectionHref("vruty", [])).toBe("/produkt/vruty");
  });
});
