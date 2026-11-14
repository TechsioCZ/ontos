import { describe, expect, it } from "vitest";
import { getCartWeight } from "@/lib/cart-weight";
import { parseStoredCart } from "@/features/cart/cart-storage";
import type { CartLine } from "@/features/cart/cart-state";

const line: CartLine = {
  productId: "p",
  variantId: "v",
  slug: "p",
  name: "V",
  sku: "S",
  imageSrc: "/p.png",
  imageAlt: "V",
  unit: "ks",
  quantity: 400,
  minimumQuantity: 1,
  stockCount: 1000,
  priceMinor: 100,
  unitWeightKg: 0.0034,
};

// Weights come from the line (`unitWeightKg`, refreshed by the OntOS cart quote); see ontos-quote.test.ts.
describe("cart weight from sales-unit data", () => {
  it("counts base quantities once, including multiple packages and decimal sales units", () => {
    const result = getCartWeight({
      version: 3,
      lines: [line, { ...line, unit: "m", quantity: 2.5, unitWeightKg: 1.2 }],
    });
    expect(result.complete).toBe(true);
    expect(result.knownKg).toBeCloseTo(4.36);
  });

  it("reports incomplete totals instead of interpreting unknown, zero or invalid weights as zero", () => {
    for (const weight of [undefined, 0, -1, NaN, Infinity]) {
      const result = getCartWeight({
        version: 3,
        lines: [line, { ...line, unitWeightKg: weight }],
      });
      expect(result).toEqual({ knownKg: 1.3599999999999999, missingLines: 1, complete: false });
    }
  });

  it("does not show numeric overflow as a complete weight", () => {
    const huge = { ...line, unitWeightKg: Number.MAX_VALUE, quantity: 1 };
    expect(getCartWeight({ version: 3, lines: [huge, { ...huge, variantId: "w" }] })).toEqual({
      knownKg: 0,
      missingLines: 2,
      complete: false,
    });
  });

  it("updates with quantity/removal and leaves old lines without a weight unknown", () => {
    expect(getCartWeight({ version: 3, lines: [{ ...line, quantity: 100 }] }).knownKg).toBeCloseTo(
      0.34,
    );
    expect(getCartWeight({ version: 3, lines: [] })).toEqual({
      knownKg: 0,
      missingLines: 0,
      complete: true,
    });
    const { unitWeightKg: _unused, ...oldLine } = line;
    expect(getCartWeight({ version: 3, lines: [oldLine] }).complete).toBe(false);
  });

  it("preserves verified weights through storage and accepts old carts without one", () => {
    expect(
      parseStoredCart(JSON.stringify({ version: 3, lines: [line] })).lines[0].unitWeightKg,
    ).toBe(0.0034);
    expect(
      parseStoredCart(JSON.stringify({ version: 3, lines: [{ ...line, unitWeightKg: -1 }] }))
        .lines[0].unitWeightKg,
    ).toBeUndefined();
  });
});
