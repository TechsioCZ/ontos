import { describe, it, expect } from "vitest";
import {
  firstOrderableQuantity,
  isOrderQuantityValid,
  orderQuantityRules,
} from "@app/merchandise/domain/order-quantity";
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

const projectedVariant = (minimumQuantity: number, packageQuantity: number, stockOnHand: number) =>
  projectProducts({
    revision: 1,
    products: [
      {
        id: "p",
        slug: "screw",
        name: "Screw",
        active: true,
        variantSummary: { count: 1, minGrossPriceMinor: 121, stockOnHand, units: ["ks"] },
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
            minimumQuantity,
            packageQuantity,
            stockOnHand,
          },
        ],
      },
    ],
  }).products[0];

describe("AKROS order quantities follow the owner's order rule", () => {
  it.each([
    // 10835300: sold from 1 ks in packages of 10; 26 in stock sells 10 or 20.
    { minimum: 1, pack: 10, stock: 26, first: 10, maximum: 20 },
    // 10799700030030: minimum 10 ks, packages of 200; 450 in stock sells 200 or 400.
    { minimum: 10, pack: 200, stock: 450, first: 200, maximum: 400 },
    // A minimum that is no whole number of packages rounds up to the next package.
    { minimum: 75, pack: 50, stock: 149, first: 100, maximum: 100 },
    { minimum: 400, pack: 200, stock: 1000, first: 400, maximum: 1000 },
    { minimum: 0.5, pack: 1.5, stock: 7, first: 1.5, maximum: 6 },
  ])(
    "sells $minimum ks in packages of $pack from its first whole package: %j",
    ({ minimum, pack, stock, first, maximum }) => {
      const projected = projectedVariant(minimum, pack, stock);
      const variant = projected.detail.variants[0];
      expect(variant).toMatchObject({
        minimumQuantity: first,
        quantityStep: pack,
        packageQuantity: pack,
        stockCount: stock,
      });
      // The product-level control of a single-variant product reads the same rule.
      expect(projected).toMatchObject({ minimumQuantity: first, quantityStep: pack });
      expect(first).toBe(
        firstOrderableQuantity({ minimumQuantity: minimum, packageQuantity: pack }),
      );
      const live = { ...item, stockCount: stock, ...purchaseConstraints(minimum, pack) };
      expect(getMaximumOrderQuantity(live)).toBe(maximum);
      // Every quantity the controls can compose is one the owner accepts, and nothing beyond it.
      const owner = orderQuantityRules({
        minimumQuantity: minimum,
        packageQuantity: pack,
        stockOnHand: stock,
      });
      for (
        let quantity = first;
        quantity <= maximum;
        quantity = Number((quantity + pack).toFixed(6))
      )
        expect(isOrderQuantityValid(quantity, owner)).toBe(true);
      expect(normalizeOrderQuantity(live, 1)).toBe(first);
      expect(normalizeOrderQuantity(live, first + pack / 2)).toBe(first);
      expect(normalizeOrderQuantity(live, maximum + pack)).toBe(maximum);
      const cart = cartReducer(createEmptyCart(), { type: "add", item: live, quantity: first });
      expect(cart.lines[0]?.quantity).toBe(first);
      expect(parseStoredCart(JSON.stringify(cart))).toEqual(cart);
    },
  );
  it("keeps the rule when a quote or reorder refreshes an already projected line", () => {
    const projected = purchaseConstraints(1, 10);
    expect(purchaseConstraints(projected.minimumQuantity, 10)).toEqual(projected);
  });
  it.each([
    { minimum: 6, stock: 29, maximum: 24 },
    { minimum: 10, stock: 280, maximum: 280 },
    { minimum: 100, stock: 250, maximum: 200 },
    { minimum: 0.5, stock: 143.9, maximum: 143.5 },
  ])(
    "an unpackaged source minimum stays the order increment: %j",
    ({ minimum, stock, maximum }) => {
      const live = { ...item, stockCount: stock, ...purchaseConstraints(minimum) };
      expect(live.quantityStep).toBe(minimum);
      expect(getMaximumOrderQuantity(live)).toBe(maximum);
      expect(normalizeOrderQuantity(live, minimum * 2)).toBe(minimum * 2);
    },
  );
  it("normalizes off-step cart requests to a valid order increment", () => {
    const live = { ...item, stockCount: 29, ...purchaseConstraints(6) };
    expect(normalizeOrderQuantity(live, 15)).toBe(12);
    expect(normalizeOrderQuantity(live, 2)).toBe(6);
    expect(normalizeOrderQuantity(live, 30)).toBe(24);
  });
  it("blocks stock below the first order", () => {
    expect(getMaximumOrderQuantity({ ...item, stockCount: 5, ...purchaseConstraints(6) })).toBe(0);
    // 6 ks held, packages of 10: nothing can be ordered.
    expect(getMaximumOrderQuantity({ ...item, stockCount: 6, ...purchaseConstraints(1, 10) })).toBe(
      0,
    );
    // 10 ks held, minimum 10 in packages of 200.
    expect(
      getMaximumOrderQuantity({ ...item, stockCount: 10, ...purchaseConstraints(10, 200) }),
    ).toBe(0);
  });
});
