import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectProducts as project } from "@/ontos/catalog-projection";
import { readCartProducts } from "@/ontos/catalog-server";
import { callAction } from "@/ontos/gateway";
import { quoteCart } from "@/ontos/quote";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/catalog-server", () => ({ readCartProducts: vi.fn() }));
vi.mock("@/ontos/gateway", () => ({ callAction: vi.fn() }));

const product = (variant: Record<string, unknown>) => ({
  id: "p",
  slug: "vruty",
  name: "Vruty",
  active: true,
  vatRate: 21,
  availability: variant.availability ?? "IN_STOCK",
  variantSummary: { count: 1, minGrossPriceMinor: 121, stockOnHand: 1000, units: ["ks"] },
  variantRecords: [
    {
      id: "v",
      sku: "V-1",
      name: "3,5 × 16",
      active: true,
      priceMinor: 100,
      grossPriceMinor: 121,
      stockOnHand: 1000,
      availability: "IN_STOCK",
      minimumQuantity: 1,
      priceTiers: [
        { minimumQuantity: 1, priceMinor: 121, priceExcludingVatMinor: 100 },
        { minimumQuantity: 100, priceMinor: 115, priceExcludingVatMinor: 95 },
        { minimumQuantity: 500, priceMinor: 109, priceExcludingVatMinor: 90 },
      ],
      ...variant,
    },
  ],
});
const cart = (quantity: number, priceMinor: number) => ({
  version: 3 as const,
  lines: [
    {
      productId: "p",
      variantId: "v",
      slug: "vruty",
      name: "Vruty",
      variantLabel: "3,5 × 16",
      sku: "V-1",
      imageSrc: "",
      imageAlt: "",
      unit: "ks",
      minimumQuantity: 1,
      stockCount: 1000,
      priceMinor,
      quantity,
    },
  ],
});

beforeEach(() => {
  vi.mocked(callAction).mockReset();
  vi.mocked(callAction).mockResolvedValue({
    storefrontOrder: { outcome: "VALID", issues: [], totalMinor: 54500, totalVatMinor: 9459 },
  });
});

describe("server cart quote", () => {
  it("blocks an item whose owner availability is UNKNOWN, naming the variant, without asking OntOS to order", async () => {
    vi.mocked(readCartProducts).mockResolvedValue(
      project({ revision: 3, products: [product({ availability: "UNKNOWN" })] }),
    );
    const quote = await quoteCart(cart(10, 121));
    expect(quote.canCheckout).toBe(false);
    expect(quote.lineIssues).toEqual([
      expect.objectContaining({ code: "AVAILABILITY_UNKNOWN", productId: "p", variantId: "v" }),
    ]);
    expect(quote.issues[0]).toMatch(/^Vruty \(3,5 × 16\): dostupnost nyní nelze ověřit/);
    expect(callAction).not.toHaveBeenCalled();
  });

  it("blocks an unpriced item", async () => {
    vi.mocked(readCartProducts).mockResolvedValue(
      project({ revision: 3, products: [product({ grossPriceMinor: 0, priceMinor: 0 })] }),
    );
    const quote = await quoteCart(cart(10, 0));
    expect(quote.canCheckout).toBe(false);
    expect(quote.lineIssues[0]?.code).toBe("PRICE_UNAVAILABLE");
    expect(quote.issues[0]).toMatch(/cena není dostupná/);
  });

  it("applies the owner quantity tier and returns OntOS dry-run totals (no browser VAT)", async () => {
    vi.mocked(readCartProducts).mockResolvedValue(
      project({ revision: 3, products: [product({})] }),
    );
    const quote = await quoteCart(cart(500, 109), "osobni");
    expect(quote.priceChanged).toBe(false);
    expect(quote.cart.lines[0]).toMatchObject({ priceMinor: 109, priceExcludingVatMinor: 90 });
    expect(quote.canCheckout).toBe(true);
    expect(quote.totals).toEqual({
      totalMinor: 54500,
      totalVatMinor: 9459,
      netMinor: 45041,
      shippingMinor: 0,
    });
    const [, , payload] = vi.mocked(callAction).mock.calls[0]!;
    expect(payload).toMatchObject({
      expectedRevision: 3,
      command: { _tag: "PlaceStorefrontOrder", dryRun: true, shippingMethod: "OSOBNI_ODBER" },
    });
  });

  it("keeps the cart blocked when OntOS itself rejects a line", async () => {
    vi.mocked(readCartProducts).mockResolvedValue(
      project({ revision: 3, products: [product({})] }),
    );
    vi.mocked(callAction).mockResolvedValue({
      storefrontOrder: {
        outcome: "REJECTED",
        issues: [
          {
            code: "AVAILABILITY_UNKNOWN",
            productId: "p",
            variantId: "v",
            message:
              "Vruty (3,5 × 16): dostupnost nyní nelze ověřit, objednávku proto nelze dokončit.",
          },
        ],
      },
    });
    const quote = await quoteCart(cart(10, 121));
    expect(quote.canCheckout).toBe(false);
    expect(quote.totals).toBeNull();
    expect(quote.lineIssues[0]?.code).toBe("AVAILABILITY_UNKNOWN");
  });
});
