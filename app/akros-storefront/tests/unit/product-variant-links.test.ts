import { describe, expect, it } from "vitest";
import {
  buildVariantQuestionHref,
  buildVariantSelectionHref,
  parseVariantIds,
  resolveVariantSelection,
} from "@/lib/product-variant-links";
import { getProducts } from "@/mock-storefront/catalog";

describe("exact variant selection URLs", () => {
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
