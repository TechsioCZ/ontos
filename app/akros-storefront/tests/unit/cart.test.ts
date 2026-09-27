import { describe, expect, it } from "vitest";

import {
  cartReducer,
  createEmptyCart,
  getCartItemCount,
  getCartSubtotal,
} from "@/mock-storefront/cart";

describe("local demo cart", () => {
  it("adds a new product and merges subsequent quantities", () => {
    const once = cartReducer(createEmptyCart(), {
      type: "add",
      productId: "product-screw",
      quantity: 1,
    });
    const three = cartReducer(once, {
      type: "add",
      productId: "product-screw",
      quantity: 2,
    });

    expect(three.lines).toEqual([{ productId: "product-screw", quantity: 3 }]);
    expect(getCartItemCount(three)).toBe(3);
  });

  it("removes a line when its quantity is set to zero", () => {
    const cart = {
      version: 1 as const,
      lines: [{ productId: "product-screw", quantity: 2 }],
    };

    expect(
      cartReducer(cart, {
        type: "set-quantity",
        productId: "product-screw",
        quantity: 0,
      }).lines,
    ).toEqual([]);
  });

  it("calculates totals in minor currency units without floating point drift", () => {
    const cart = {
      version: 1 as const,
      lines: [
        { productId: "product-screw", quantity: 3 },
        { productId: "product-rope", quantity: 2 },
      ],
    };

    const prices = new Map([
      ["product-screw", 1290],
      ["product-rope", 4590],
    ]);

    expect(getCartSubtotal(cart, (productId) => prices.get(productId))).toBe(13_050);
  });
});
