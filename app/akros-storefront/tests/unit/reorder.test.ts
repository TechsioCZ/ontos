import { describe, expect, it } from "vitest";
import { addCartItems, createEmptyCart, type CartLine } from "@/mock-storefront/cart";
import { mockOrders, demoAccount } from "@/mock-storefront/fixtures/account";
import { getProductVariantById } from "@/mock-storefront/catalog";
import { prepareReorder } from "@/mock-storefront/reorder";
import { createAccountProfile } from "@/mock-storefront/account-profile";
import { createCheckoutDraft } from "@/mock-storefront/checkout";

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

describe("reordering into an existing cart", () => {
  it("uses one demo account seed and complete independent historical orders", () => {
    expect(createAccountProfile()).toEqual(demoAccount.profile);
    expect(createCheckoutDraft().billing.street).toBe(demoAccount.profile.street);
    for (const order of mockOrders) {
      expect(order.lines.length).toBeGreaterThan(0);
      expect(order.items).toBe(order.lines.length);
      expect(order.totalMinor).toBe(
        order.shippingMinor +
          order.lines.reduce((sum, row) => sum + Math.round(row.quantity * row.priceMinor), 0),
      );
      for (const row of order.lines)
        expect(getProductVariantById(row.productId, row.variantId)?.sku).toBe(row.sku);
    }
    const profile = createAccountProfile();
    profile.street = "Edited address";
    expect(mockOrders[0].billingAddress.street).toBe(demoAccount.profile.street);
  });

  it("resolves exact variants and current prices instead of historical order prices", () => {
    const order = mockOrders[0];
    const prepared = prepareReorder(createEmptyCart(), order.lines);
    expect(prepared.result.addedLines).toBe(3);
    expect(prepared.result.notices).toEqual([]);
    expect(prepared.items[0].priceMinor).toBe(
      getProductVariantById(order.lines[0].productId, order.lines[0].variantId)?.priceMinor,
    );
    expect(prepared.items[0].priceMinor).not.toBe(order.lines[0].priceMinor);
    const missing = prepareReorder(createEmptyCart(), [
      { ...order.lines[0], variantId: "missing" },
    ]);
    expect(missing.items).toEqual([]);
    expect(missing.result.addedLines).toBe(0);
    expect(missing.result.notices[0]).toContain(order.lines[0].sku);
  });
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
  });

  it("limits additions to stock and reports unavailable or adjusted quantities", () => {
    const result = addCartItems(createEmptyCart(), [
      { ...line, stockCount: 30, quantity: 100 },
      { ...line, variantId: "out", sku: "OUT", stockCount: 0 },
    ]);
    expect(result.cart.lines).toEqual([{ ...line, stockCount: 30, quantity: 30 }]);
    expect(result.addedLines).toBe(1);
    expect(result.notices).toHaveLength(2);
    expect(result.notices.join(" ")).toContain("OUT");
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
