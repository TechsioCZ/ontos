import { describe, expect, it } from "vitest";

import {
  type CartAction,
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

  it("keeps separately selected product variants as distinct cart lines", () => {
    const firstVariant = cartReducer(createEmptyCart(), {
      type: "add",
      productId: "product-hex-bolt",
      variantId: "hex-bolt-m2x5",
      quantity: 1,
    } as CartAction);
    const secondVariant = cartReducer(firstVariant, {
      type: "add",
      productId: "product-hex-bolt",
      variantId: "hex-bolt-m2x8",
      quantity: 1,
    } as CartAction);

    expect(secondVariant.lines).toEqual([
      {
        productId: "product-hex-bolt",
        variantId: "hex-bolt-m2x5",
        quantity: 1,
      },
      {
        productId: "product-hex-bolt",
        variantId: "hex-bolt-m2x8",
        quantity: 1,
      },
    ]);
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

  it("clears all lines after completing the local checkout", () => {
    const cart = {
      version: 1 as const,
      lines: [{ productId: "product-screw", quantity: 2 }],
    };

    expect(cartReducer(cart, { type: "clear" })).toEqual(createEmptyCart());
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

  it("uses the selected variant price when calculating totals", () => {
    const cart = {
      version: 1 as const,
      lines: [
        {
          productId: "product-hex-bolt",
          variantId: "hex-bolt-m4x16",
          quantity: 3,
        },
      ],
    };

    expect(
      getCartSubtotal(cart, (_productId, variantId) =>
        variantId === "hex-bolt-m4x16" ? 194 : undefined,
      ),
    ).toBe(582);
  });
});
