import { describe, expect, it } from "vitest";
import { parseFavorites, replaceProductFavorites } from "@/mock-storefront/favorites";

const a = { productId: "p", productSlug: "vruty", variantId: "a" };
const b = { ...a, variantId: "b" };
const other = { productId: "q", productSlug: "matice", variantId: null };

describe("favorite variant references", () => {
  it("recovers from corrupt/legacy input and validates each saved reference", () => {
    for (const raw of [undefined, null, "broken", "true", "{}", "[null,{},42]"]) {
      expect(parseFavorites(raw)).toEqual([]);
    }
    expect(parseFavorites(JSON.stringify([a, a, b, other, { ...a, variantId: 1 }]))).toEqual([
      a,
      b,
      other,
    ]);
  });

  it("replaces only the chosen product, including removing its last saved variant", () => {
    expect(replaceProductFavorites([a, other], "p", [b, b, other])).toEqual([other, b]);
    expect(replaceProductFavorites([a, b, other], "p", [])).toEqual([other]);
  });
});
