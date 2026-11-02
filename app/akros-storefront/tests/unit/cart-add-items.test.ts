import { describe, expect, it } from "vitest";
import {
  addCartItems,
  cartReducer,
  createEmptyCart,
  type CartLine,
} from "@/features/cart/cart-state";

const line: CartLine = {
  productId: "p",
  variantId: "v",
  slug: "screw",
  name: "Screw",
  sku: "SKU",
  imageSrc: "/screw.png",
  imageAlt: "Screw",
  unit: "ks",
  minimumQuantity: 10,
  stockCount: 100,
  priceMinor: 200,
  quantity: 20,
};

describe("batch additions into an existing cart (reorder)", () => {
  it("preserves unrelated items and merges matching variants using current prices", () => {
    const other = { ...line, variantId: "other", quantity: 10 };
    const original = {
      version: 3 as const,
      lines: [{ ...line, priceMinor: 100, quantity: 10 }, other],
    };
    const result = addCartItems(original, [line]);
    expect(result.cart.lines).toEqual([{ ...line, quantity: 30 }, other]);
    expect(result.addedLines).toBe(1);
    expect(result.notices).toEqual([]);
    expect(original.lines[0].priceMinor).toBe(100);
    expect(cartReducer(original, { type: "reorder", items: [line] })).toEqual(result.cart);
  });

  it("limits additions to stock and reports unavailable or adjusted quantities", () => {
    const result = addCartItems(createEmptyCart(), [
      { ...line, stockCount: 30, quantity: 100 },
      { ...line, variantId: "out", sku: "OUT", stockCount: 0 },
      { ...line, variantId: "free", sku: "FREE", priceMinor: 0 },
    ]);
    expect(result.cart.lines).toEqual([{ ...line, stockCount: 30, quantity: 30 }]);
    expect(result.addedLines).toBe(1);
    expect(result.notices).toEqual([
      { sku: "SKU", kind: "limited", added: 30, requested: 100, unit: "ks" },
      { sku: "OUT", kind: "limited", added: 0, requested: 20, unit: "ks" },
      { sku: "FREE", kind: "unorderable", added: 0, requested: 20, unit: "ks" },
    ]);
  });

  it("never reduces or removes existing quantities when stock has fallen", () => {
    const cart = { version: 3 as const, lines: [{ ...line, quantity: 50 }] };
    const result = addCartItems(cart, [{ ...line, stockCount: 30 }]);
    expect(result.cart.lines[0].quantity).toBe(50);
    expect(result.addedLines).toBe(0);
    expect(result.notices).toHaveLength(1);
  });

  it("handles decimal sales units without multiplying package quantities", () => {
    const result = addCartItems(createEmptyCart(), [
      { ...line, unit: "m", minimumQuantity: 0.5, stockCount: 3.5, quantity: 2.5 },
    ]);
    expect(result.cart.lines[0].quantity).toBe(2.5);
  });

  it("ignores floating point noise and never rounds a request up to a new minimum", () => {
    const decimal = { ...line, unit: "m", minimumQuantity: 0.1, stockCount: 10, quantity: 0.3 };
    const result = addCartItems({ version: 3, lines: [decimal] }, [{ ...decimal, quantity: 0.6 }]);
    expect(result.cart.lines[0].quantity).toBe(0.9);
    expect(result.notices).toEqual([]);
    const belowMinimum = addCartItems(createEmptyCart(), [{ ...line, quantity: 5 }]);
    expect(belowMinimum.cart.lines).toEqual([]);
    expect(belowMinimum.notices).toHaveLength(1);
  });
});
