import { describe, it, expect } from "vitest";
import { purchaseConstraints } from "@/ontos/purchase-constraints";
import {
  cartReducer,
  createEmptyCart,
  getMaximumOrderQuantity,
  normalizeOrderQuantity,
} from "@/features/cart/cart-state";
import { parseStoredCart } from "@/features/cart/cart-storage";
import { projectProducts } from "@/ontos/catalog-projection";

const item = {
  productId: "p",
  slug: "p",
  name: "Material",
  sku: "P",
  imageSrc: "",
  imageAlt: "",
  unit: "ks",
  priceMinor: 121,
};

describe("AKROS order increments", () => {
  it("preserves source packaging separately when projecting a smaller sale increment", () => {
    const page = projectProducts({
      revision: 1,
      products: [
        {
          id: "p",
          slug: "screw",
          name: "Screw",
          active: true,
          variantSummary: { count: 1, minGrossPriceMinor: 121, stockOnHand: 200, units: ["ks"] },
          variantRecords: [
            {
              id: "v",
              sku: "V",
              name: "Screw",
              active: true,
              unit: "ks",
              priceMinor: 100,
              grossPriceMinor: 121,
              availability: "IN_STOCK",
              minimumQuantity: 50,
              packageQuantity: 500,
              stockOnHand: 200,
            },
          ],
        },
      ],
    });
    expect(page.products[0].detail.variants[0]).toMatchObject({
      minimumQuantity: 50,
      quantityStep: 50,
      packageQuantity: 500,
      stockCount: 200,
    });
  });
  it.each([
    { minimum: 6, stock: 29, maximum: 24 },
    { minimum: 10, stock: 280, maximum: 280 },
    { minimum: 50, stock: 200, maximum: 200 },
    { minimum: 100, stock: 250, maximum: 200 },
    { minimum: 0.5, stock: 143.9, maximum: 143.5 },
  ])(
    "preserves order increments through cart edits and reload: %j",
    ({ minimum, stock, maximum }) => {
      const live = { ...item, stockCount: stock, ...purchaseConstraints(minimum) };
      expect(getMaximumOrderQuantity(live)).toBe(maximum);
      expect(normalizeOrderQuantity(live, minimum * 2)).toBe(minimum * 2);
      const cart = cartReducer(createEmptyCart(), { type: "add", item: live, quantity: minimum });
      expect(cart.lines[0]?.quantity).toBe(minimum);
      expect(parseStoredCart(JSON.stringify(cart))).toEqual(cart);
    },
  );
  it("normalizes off-step cart requests to a valid order increment", () => {
    const live = { ...item, stockCount: 29, ...purchaseConstraints(6) };
    expect(normalizeOrderQuantity(live, 15)).toBe(12);
    expect(normalizeOrderQuantity(live, 2)).toBe(6);
    expect(normalizeOrderQuantity(live, 30)).toBe(24);
  });
  it("blocks stock below the smallest order increment", () => {
    expect(getMaximumOrderQuantity({ ...item, stockCount: 5, ...purchaseConstraints(6) })).toBe(0);
  });
});
