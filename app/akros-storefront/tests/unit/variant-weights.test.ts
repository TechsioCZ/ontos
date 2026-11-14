import { describe, expect, it } from "vitest";
import { projectProducts } from "@/ontos/catalog-projection";
import { sourceUnitWeightKg } from "@/ontos/variant-weights";
import { buildVariantWeights } from "../../scripts/variant-weights.mjs";

const variantRecord = (sku: string, unit = "ks") => ({
  id: `variant-${sku}`,
  sku,
  name: sku,
  sourceUnit: unit,
  grossPriceMinor: 121,
  priceMinor: 100,
  availability: "IN_STOCK",
  stockOnHand: 10,
});

describe("source unit weights", () => {
  it("keeps only positive piece and metre weights and drops ambiguous SKUs", () => {
    const weights = buildVariantWeights([
      { sku: "P1", unit: "ks", netWeight: 2.5, detail: { variants: [] } },
      {
        sku: "G",
        unit: "ks",
        netWeight: 9,
        detail: {
          variants: [
            { sku: "V-ks", unit: "ks", sourceNetWeight: 0.2 },
            { sku: "V-m", unit: "m", sourceNetWeight: 0.06 },
            { sku: "V-zero", unit: "ks", sourceNetWeight: 0 },
            { sku: "V-set", unit: "set", sourceNetWeight: 1 },
            { sku: "DUP", unit: "ks", sourceNetWeight: 1 },
            { sku: "dup", unit: "ks", sourceNetWeight: 2 },
          ],
        },
      },
    ]);
    expect(weights).toEqual({ p1: 2.5, "v-ks": 0.2, "v-m": 0.06 });
  });

  it("resolves a known feed SKU only for its sales unit", () => {
    // Source feed: DIN 766/A4 2 mm chain, 0.001 kg per metre.
    expect(sourceUnitWeightKg("10076604020000", "m")).toBe(0.001);
    expect(sourceUnitWeightKg(" 10076604020000 ", "M")).toBe(0.001);
    expect(sourceUnitWeightKg("10076604020000", "bal")).toBeUndefined();
    expect(sourceUnitWeightKg("not-a-feed-sku", "ks")).toBeUndefined();
  });

  it("projects variant weights without inheriting them to the variant group", () => {
    const page = projectProducts({
      products: [
        {
          id: "product-1",
          slug: "chain",
          name: "Chain",
          sku: "group",
          active: true,
          currency: "CZK",
          variantSummary: { count: 2, minGrossPriceMinor: 121, stockOnHand: 20, units: ["m"] },
          variantRecords: [variantRecord("10076604020000", "m"), variantRecord("unknown-sku")],
        },
      ],
    });
    const [product] = page.products;
    expect(product.netWeight).toBeUndefined();
    expect(product.detail.variants.map((variant) => variant.sourceNetWeight)).toEqual([
      0.001,
      undefined,
    ]);
  });
});
