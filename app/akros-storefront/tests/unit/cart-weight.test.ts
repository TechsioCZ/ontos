import { describe, expect, it } from "vitest";
import { getCartWeight } from "@/lib/cart-weight";
import { parseStoredCart } from "@/mock-storefront/cart-storage";
import type { CartLine } from "@/mock-storefront/cart";

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
describe("cart weight from sales-unit data", () => {
  it("uses exact catalog weights for existing piece and metre lines without a stored weight", () => {
    const { unitWeightKg: _unused, ...oldLine } = line;
    const screw = {
      ...oldLine,
      productId: "product-20532",
      variantId: "item-4746",
      sku: "10799700040030",
      quantity: 20,
    };
    const rope = {
      ...oldLine,
      productId: "product-21599",
      variantId: "item-966",
      sku: "10305304040011",
      unit: "m",
      quantity: 2.5,
    };
    expect(getCartWeight({ version: 3, lines: [screw, rope] })).toEqual({
      complete: true,
      missingLines: 0,
      knownKg: expect.closeTo(0.218, 6),
    });
    expect(getCartWeight({ version: 3, lines: [{ ...screw, quantity: 200 }] }).knownKg).toBeCloseTo(
      0.68,
    );
    expect(
      getCartWeight({
        version: 3,
        lines: [
          {
            ...oldLine,
            productId: "product-34388",
            variantId: undefined,
            sku: "10000105000000",
            quantity: 2,
          },
        ],
      }).knownKg,
    ).toBeCloseTo(0.068);
  });

  it("uses positive metre weights without guessing their physical plausibility", () => {
    const { unitWeightKg: _unused, ...oldLine } = line;
    for (const [productId, variantId, sku, unitWeight] of [
      ["product-17872", "item-35974", "10SOLTS1004000", 0.01061],
      ["product-21600", "item-4353", "10306004040071", 0.001],
      ["product-20724", "item-6263", "10076604020000", 0.001],
    ] as const) {
      const result = getCartWeight({
        version: 3,
        lines: [{ ...oldLine, productId, variantId, sku, unit: "m", quantity: 100 }],
      });
      expect(result.complete).toBe(true);
      expect(result.knownKg).toBeCloseTo(unitWeight * 100, 6);
    }
  });

  it("rejects missing identities, parent fallback, zero values and mismatched sales units", () => {
    const { unitWeightKg: _unused, ...oldLine } = line;
    for (const item of [
      { ...oldLine, productId: "product-20532", variantId: undefined, sku: "10799700" },
      { ...oldLine, productId: "product-20532", variantId: "item-4746", sku: "wrong" },
      {
        ...oldLine,
        productId: "product-20532",
        variantId: "item-4746",
        sku: "10799700040030",
        unit: "m",
      },
      { ...oldLine, productId: "product-19408", variantId: "item-3967", sku: "18kop009080000" },
    ])
      expect(getCartWeight({ version: 3, lines: [item] }).complete).toBe(false);
  });
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
  it("updates with quantity/removal and leaves unmatched old cart identities unknown", () => {
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
