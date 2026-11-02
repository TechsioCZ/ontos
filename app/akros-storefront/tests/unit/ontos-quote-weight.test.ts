import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectProducts as project } from "@/ontos/catalog-projection";
import { readCartProducts } from "@/ontos/catalog-server";
import { callAction } from "@/ontos/gateway";
import { quoteCart } from "@/ontos/quote";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/catalog-server", () => ({ readCartProducts: vi.fn() }));
vi.mock("@/ontos/gateway", () => ({ callAction: vi.fn() }));
// Source feed index: kg per sales unit by SKU (ks/m only), as variant-weights.ts resolves it.
vi.mock("@/ontos/variant-weights", () => ({
  sourceUnitWeightKg: (sku: string, unit: string) =>
    unit === "ks"
      ? ({ "v-1": 0.0034, "solo-1": 0.5 } as Record<string, number>)[sku.toLowerCase()]
      : undefined,
}));

const variant = (id: string, sku: string) => ({
  id,
  sku,
  name: id,
  active: true,
  priceMinor: 100,
  grossPriceMinor: 121,
  stockOnHand: 1000,
  availability: "IN_STOCK",
  minimumQuantity: 1,
});
const group = {
  id: "p",
  slug: "vruty",
  name: "Vruty",
  active: true,
  vatRate: 21,
  availability: "IN_STOCK",
  variantSummary: { count: 2, minGrossPriceMinor: 121, stockOnHand: 2000, units: ["ks"] },
  variantRecords: [variant("v", "V-1"), variant("w", "W-1")],
};
const solo = {
  id: "s",
  slug: "solo",
  sku: "SOLO-1",
  name: "Solo",
  active: true,
  vatRate: 21,
  currentPriceMinor: 100,
  grossPriceMinor: 121,
  stockOnHand: 10,
  availability: "IN_STOCK",
  variantSummary: { count: 0, units: [] },
};
const line = (productId: string, variantId: string | undefined, extra: object = {}) => ({
  productId,
  ...(variantId ? { variantId } : {}),
  slug: productId,
  name: productId,
  sku: "",
  imageSrc: "",
  imageAlt: "",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 1000,
  priceMinor: 121,
  quantity: 2,
  ...extra,
});

beforeEach(() => {
  vi.mocked(callAction).mockReset();
  vi.mocked(callAction).mockResolvedValue({
    storefrontOrder: { outcome: "VALID", issues: [], totalMinor: 726, totalVatMinor: 126 },
  });
  vi.mocked(readCartProducts).mockResolvedValue(project({ revision: 1, products: [group, solo] }));
});

describe("server cart quote weights", () => {
  it("refreshes kg per sales unit from the projected variant or variant-less product", async () => {
    const quote = await quoteCart({
      version: 3,
      lines: [line("p", "v"), line("p", "w", { unitWeightKg: 9 }), line("s", undefined)],
    });
    expect(quote.issues).toEqual([]);
    expect(quote.canCheckout).toBe(true);
    expect(quote.cart.lines.map((l) => l.unitWeightKg)).toEqual([0.0034, undefined, 0.5]);
    // Weight never reaches the OntOS order command.
    expect(JSON.stringify(vi.mocked(callAction).mock.calls[0]![2])).not.toContain("unitWeightKg");
  });

  it("is stable: a refreshed cart quotes to the same cart (no revalidation loop)", async () => {
    const first = await quoteCart({ version: 3, lines: [line("p", "v"), line("s", undefined)] });
    const second = await quoteCart(first.cart);
    expect(JSON.stringify(second.cart)).toBe(JSON.stringify(first.cart));
  });
});
