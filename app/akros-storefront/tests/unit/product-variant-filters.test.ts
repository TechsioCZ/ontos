import { describe, expect, it } from "vitest";
import { getVariantRangeFilters } from "@/lib/product-variant-filters";
import { getProductBySlug } from "@/mock-storefront/catalog";

const product = getProductBySlug("vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2")!;
const variant = product.detail.variants[0];

describe("variant filter dimensions", () => {
  it("keeps price and material out of fastener filters and accepts Czech decimals", () => {
    const variants = [
      { ...variant, id: "a", label: "vrut 3,5 x 16 /A2", parameters: [] },
      { ...variant, id: "b", label: "vrut 4.5 x 25 /A4", priceMinor: 99000, parameters: [] },
    ];
    const filters = getVariantRangeFilters(product, variants);
    expect(filters.map((filter) => [filter.label, filter.bounds, filter.step])).toEqual([
      ["Průměr (mm)", [3.5, 4.5], 0.1],
      ["Délka (mm)", [16, 25], 1],
    ]);
    expect(filters[0].values.get("b")).toBe(4.5);
  });

  it("uses thickness, width and length for sheets, not diameter", () => {
    const filters = getVariantRangeFilters({ name: "PLECHY BROUŠENÉ" }, [
      { ...variant, id: "a", label: "plech 0.5x1000x2000", parameters: [] },
      { ...variant, id: "b", label: "plech 1.0x1250x2500", parameters: [] },
    ]);
    expect(filters.map((filter) => filter.label)).toEqual([
      "Tloušťka (mm)",
      "Šířka (mm)",
      "Délka (mm)",
    ]);
    expect(filters[0].bounds).toEqual([0.5, 1]);
  });

  it("distinguishes a round tube's wall from a rectangular tube's height", () => {
    const variants = [
      { ...variant, id: "a", label: "trubka 20x1.5", parameters: [] },
      { ...variant, id: "b", label: "trubka 30x2.0", parameters: [] },
    ];
    expect(
      getVariantRangeFilters({ name: "TRUBKY KRUHOVÉ" }, variants).map((filter) => filter.label),
    ).toEqual(["Vnější průměr (mm)", "Tloušťka stěny (mm)"]);
    expect(
      getVariantRangeFilters(
        { name: "TRUBKY ČTVERCOVÉ" },
        variants.map((item) => ({ ...item, label: item.label.replace("x", "x25x") })),
      ).map((filter) => filter.label),
    ).toEqual(["Šířka (mm)", "Tloušťka stěny (mm)"]);
  });

  it("does not assign made-up dimensions to unknown families or three-part fasteners", () => {
    const variants = [
      { ...variant, id: "a", label: "destička 45x16", parameters: [] },
      { ...variant, id: "b", label: "destička 81x25", parameters: [] },
    ];
    expect(getVariantRangeFilters({ name: "DESTIČKY" }, variants)).toEqual([]);
    expect(
      getVariantRangeFilters(
        product,
        variants.map((item) => ({ ...item, label: `${item.label}x2` })),
      ),
    ).toEqual([]);
  });

  it("uses explicit complete parameters without inventing a missing unit", () => {
    const variants = [2.2, 2.7].map((value, index) => ({
      ...variant,
      id: String(index),
      parameters: [{ label: "Vnitřní průměr", value: String(value), unit: "" }],
    }));
    expect(
      getVariantRangeFilters({ name: "PODLOŽKY" }, variants).map((filter) => filter.label),
    ).toEqual(["Vnitřní průměr"]);
    expect(
      getVariantRangeFilters({ name: "PODLOŽKY" }, [
        variants[0],
        { ...variants[1], parameters: [] },
      ]),
    ).toEqual([]);
  });

  it("omits conflicting feed dimensions and constant or incomplete ranges", () => {
    const variants = [
      {
        ...variant,
        id: "a",
        label: "vrut 3x30",
        parameters: [{ label: "Délka", value: "60", unit: "mm" }],
      },
      { ...variant, id: "b", label: "vrut 4x70", parameters: [] },
    ];
    expect(getVariantRangeFilters(product, variants).map((filter) => filter.id)).toEqual([
      "diameter",
    ]);
    expect(getVariantRangeFilters(product, [variants[0]])).toEqual([]);
    expect(getVariantRangeFilters(product, [variants[1], { ...variants[1], id: "c" }])).toEqual([]);
    expect(
      getVariantRangeFilters(product, [variants[0], { ...variants[1], label: "bez rozměrů" }]),
    ).toEqual([]);
  });
});
