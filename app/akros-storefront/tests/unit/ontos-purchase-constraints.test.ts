import { describe, it, expect } from "vitest";
import { purchaseConstraints } from "@/ontos/purchase-constraints";
import {
  cartReducer,
  createEmptyCart,
  getMaximumOrderQuantity,
  normalizeOrderQuantity,
} from "@/features/cart/cart-state";
import { parseStoredCart } from "@/features/cart/cart-storage";
const item = {
  productId: "p",
  slug: "p",
  name: "Materiál",
  sku: "P",
  imageSrc: "",
  imageAlt: "",
  unit: "ks",
  priceMinor: 121,
  stockCount: 1100,
};
describe("OntOS mandatory packages", () => {
  it.each([undefined, 0])("keeps an unpackaged minimum as a lower bound (%s)", (pack) => {
    const live = { ...item, stockCount: 15, ...purchaseConstraints(10, pack) };
    expect(live.minimumQuantity).toBe(10);
    expect(live.quantityStep).toBe(1);
    expect(getMaximumOrderQuantity(live)).toBe(15);
    expect(normalizeOrderQuantity(live, 15)).toBe(15);
    expect(normalizeOrderQuantity(live, 3)).toBe(10);
    const cart = cartReducer(createEmptyCart(), { type: "add", item: live, quantity: 15 });
    expect(parseStoredCart(JSON.stringify(cart))).toEqual(cart);
    expect(cart.lines[0]?.quantity).toBe(15);
  });
  it("preserves fractional minima without treating the minimum as a package", () => {
    const live = { ...item, stockCount: 1.75, ...purchaseConstraints(1.25) };
    expect(live.minimumQuantity).toBe(1.25);
    expect(getMaximumOrderQuantity(live)).toBe(1.75);
    expect(normalizeOrderQuantity(live, 1.75)).toBe(1.75);
  });
  it.each([
    [20, 200, 200],
    [0.5, 100, 100],
    [300, 200, 400],
    [0.3, 0.1, 0.3],
  ])("rounds %s minimum to %s package", (minimum, pack, expected) => {
    expect(purchaseConstraints(minimum, pack)).toEqual({
      minimumQuantity: expected,
      quantityStep: pack,
    });
  });
  it("keeps legal package increments even when minimum spans multiple packages, including reload", () => {
    const live = { ...item, ...purchaseConstraints(300, 200) };
    expect(getMaximumOrderQuantity(live)).toBe(1000);
    expect(normalizeOrderQuantity(live, 600)).toBe(600);
    expect(normalizeOrderQuantity(live, 20)).toBe(400);
    const cart = cartReducer(createEmptyCart(), { type: "add", item: live, quantity: 600 });
    expect(parseStoredCart(JSON.stringify(cart))).toEqual(cart);
  });
  it("disables stock insufficient for even one package", () => {
    expect(
      getMaximumOrderQuantity({ ...item, stockCount: 199, ...purchaseConstraints(20, 200) }),
    ).toBe(0);
  });
});
