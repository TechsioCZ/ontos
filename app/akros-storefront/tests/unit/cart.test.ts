import { describe, expect, it } from "vitest";

import {
  type CartItemSnapshot,
  cartReducer,
  createEmptyCart,
  getCartItemCount,
  getCartSubtotal,
} from "@/mock-storefront/cart";

const screw: CartItemSnapshot = {
  productId: "product-screw",
  slug: "screw",
  name: "Screw",
  sku: "SKU-1",
  imageSrc: "/screw.png",
  imageAlt: "Screw",
  unit: "ks",
  stockCount: 100,
  priceMinor: 1_290,
};

const variant = (id: string, priceMinor = 194): CartItemSnapshot => ({
  ...screw,
  productId: "product-hex-bolt",
  variantId: id,
  variantLabel: id,
  priceMinor,
});

describe("local demo cart", () => {
  it("adds a new product and merges subsequent quantities", () => {
    const once = cartReducer(createEmptyCart(), { type: "add", item: screw, quantity: 1 });
    const three = cartReducer(once, { type: "add", item: screw, quantity: 2 });

    expect(three.lines).toEqual([{ ...screw, quantity: 3 }]);
    expect(getCartItemCount(three)).toBe(3);
  });

  it("keeps separately selected product variants as distinct cart lines", () => {
    const firstVariant = cartReducer(createEmptyCart(), {
      type: "add",
      item: variant("hex-bolt-m2x5"),
      quantity: 1,
    });
    const secondVariant = cartReducer(firstVariant, {
      type: "add",
      item: variant("hex-bolt-m2x8"),
      quantity: 1,
    });

    expect(secondVariant.lines).toEqual([
      { ...variant("hex-bolt-m2x5"), quantity: 1 },
      { ...variant("hex-bolt-m2x8"), quantity: 1 },
    ]);
  });

  it("removes a line when its quantity is set to zero", () => {
    const cart = { version: 2 as const, lines: [{ ...screw, quantity: 2 }] };

    expect(
      cartReducer(cart, {
        type: "set-quantity",
        productId: screw.productId,
        quantity: 0,
      }).lines,
    ).toEqual([]);
  });

  it("clears all lines after completing the local checkout", () => {
    const cart = { version: 2 as const, lines: [{ ...screw, quantity: 2 }] };

    expect(cartReducer(cart, { type: "clear" })).toEqual(createEmptyCart());
  });

  it("calculates totals from the immutable item snapshots", () => {
    const cart = {
      version: 2 as const,
      lines: [
        { ...screw, quantity: 3 },
        { ...variant("rope", 4_590), quantity: 2 },
      ],
    };

    expect(getCartSubtotal(cart)).toBe(13_050);
  });
});
