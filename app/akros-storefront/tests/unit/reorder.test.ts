import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/account/reorder/route";
import { createEmptyCart } from "@/features/cart/cart-state";
import { parseReorderResolution, prepareReorder } from "@/features/account/reorder";
import { cs } from "@/i18n/cs";
import { en } from "@/i18n/en";
import { readAccount } from "@/ontos/account";
import { projectProducts as project } from "@/ontos/catalog-projection";
import { readCartProducts } from "@/ontos/catalog-server";
import { readCustomerOrders } from "@/ontos/customer-orders";
import type { CustomerOrder } from "@/ontos/order-model";
import { resolveReorder } from "@/ontos/reorder";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/account", () => ({
  readAccount: vi.fn<typeof import("@/ontos/account").readAccount>(),
}));
vi.mock("@/ontos/catalog-server", () => ({
  readCartProducts: vi.fn<typeof import("@/ontos/catalog-server").readCartProducts>(),
}));
vi.mock("@/ontos/customer-orders", () => ({
  readCustomerOrders: vi.fn<typeof import("@/ontos/customer-orders").readCustomerOrders>(),
}));

const variantRecord = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  sku: `SKU-${id}`,
  name: `M 6 × ${id}`,
  active: true,
  priceMinor: 100,
  grossPriceMinor: 121,
  stockOnHand: 1000,
  availability: "IN_STOCK",
  minimumQuantity: 10,
  priceTiers: [
    { minimumQuantity: 1, priceMinor: 121, priceExcludingVatMinor: 100 },
    { minimumQuantity: 100, priceMinor: 115, priceExcludingVatMinor: 95 },
  ],
  ...overrides,
});
const catalog = (...variants: ReturnType<typeof variantRecord>[]) =>
  project({
    revision: 1,
    products: [
      {
        id: "p",
        slug: "srouby",
        name: "Šrouby",
        active: true,
        vatRate: 21,
        availability: "IN_STOCK",
        variantSummary: { count: 3, minGrossPriceMinor: 121, stockOnHand: 3000, units: ["ks"] },
        variantRecords: variants,
      },
    ],
  });
const orderLine = (variantId: string, quantity: number): CustomerOrder["lines"][number] => ({
  productId: "p",
  productName: "Šrouby",
  sku: `SKU-${variantId}`,
  quantity,
  // Saved receipt price: never reused for the new cart.
  unitPriceMinor: 99,
  vatRate: 21,
  variantId,
  variantName: `M 6 × ${variantId}`,
});

describe("repeat order resolution", () => {
  it("resolves the exact ordered variants at current OntOS prices and tiers", () => {
    const { items, skipped } = resolveReorder(
      { lines: [orderLine("a", 20), orderLine("b", 200)] },
      catalog(variantRecord("a"), variantRecord("b")),
    );
    expect(skipped).toEqual([]);
    expect(items.map((item) => [item.variantId, item.quantity, item.priceMinor])).toEqual([
      ["a", 20, 121],
      ["b", 200, 115],
    ]);
    expect(items[0]).toMatchObject({
      productId: "p",
      slug: "srouby",
      name: "Šrouby",
      sku: "SKU-a",
      unit: "ks",
      minimumQuantity: 10,
      stockCount: 1000,
      priceExcludingVatMinor: 100,
    });
  });

  it("skips variants no longer offered, without a price or with unknown availability", () => {
    const { items, skipped } = resolveReorder(
      { lines: [orderLine("gone", 10), orderLine("free", 10), orderLine("unknown", 10)] },
      catalog(
        variantRecord("free", { priceMinor: 0, grossPriceMinor: 0, priceTiers: [] }),
        variantRecord("unknown", { availability: "UNKNOWN" }),
      ),
    );
    expect(items).toEqual([]);
    expect(skipped).toEqual([
      { sku: "SKU-gone", reason: "not-offered" },
      { sku: "SKU-free", reason: "price-unavailable" },
      { sku: "SKU-unknown", reason: "availability-unknown" },
    ]);
  });

  it("words skipped lines and stock limits from the market dictionary", () => {
    const resolution = resolveReorder(
      { lines: [orderLine("a", 2000), orderLine("gone", 10)] },
      catalog(variantRecord("a")),
    );
    const prepared = prepareReorder(createEmptyCart(), resolution, cs);
    expect(prepared.result.addedLines).toBe(1);
    expect(prepared.result.notices).toEqual([
      "SKU-gone: varianta již není v nabídce.",
      expect.stringMatching(/^SKU-a: přidáno 1\s000 z 2\s000 ks/),
    ]);
    expect(prepareReorder(createEmptyCart(), resolution, en).result.notices[0]).toBe(
      "SKU-gone: this variant is no longer offered.",
    );
  });

  it("accepts only well-formed route bodies", () => {
    expect(parseReorderResolution({ items: [], skipped: [] })).toEqual({ items: [], skipped: [] });
    expect(parseReorderResolution({ items: [{ productId: "p" }], skipped: [] })).toBeNull();
    expect(parseReorderResolution({ items: [], skipped: [{ sku: "x", reason: "x" }] })).toBeNull();
    expect(parseReorderResolution(null)).toBeNull();
  });
});

describe("POST /api/ontos/account/reorder", () => {
  const request = (body: unknown, origin = "https://shop.test") =>
    new Request("https://shop.test/api/ontos/account/reorder", {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: "shop.test", cookie: "c=1" },
      body: JSON.stringify(body),
    });
  const account = { id: "acc", partyId: "party", tenantId: "t", email: "a@b.cz", name: "A" };
  beforeEach(() => {
    vi.mocked(readAccount).mockReset().mockResolvedValue(account);
    vi.mocked(readCartProducts)
      .mockReset()
      .mockResolvedValue(catalog(variantRecord("a")));
    vi.mocked(readCustomerOrders)
      .mockReset()
      .mockResolvedValue({
        total: 1,
        orders: [{ id: "o1", lines: [orderLine("a", 20)] } as CustomerOrder],
      });
  });

  it("reads the order of the admitted session only and resolves it against the catalogue", async () => {
    const response = await POST(request({ orderId: "o1", customerAccountId: "someone-else" }));
    expect(response.status).toBe(200);
    expect(readCustomerOrders).toHaveBeenCalledExactlyOnceWith(account, "o1");
    expect(readCartProducts).toHaveBeenCalledWith([expect.objectContaining({ variantId: "a" })]);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ variantId: "a", quantity: 20, priceMinor: 121 });
  });

  it("refuses guests, foreign origins and unknown orders", async () => {
    vi.mocked(readAccount).mockResolvedValueOnce(null);
    expect((await POST(request({ orderId: "o1" }))).status).toBe(401);
    expect((await POST(request({ orderId: "o1" }, "https://evil.test"))).status).toBe(403);
    expect((await POST(request({}))).status).toBe(400);
    vi.mocked(readCustomerOrders).mockResolvedValueOnce({ total: 0, orders: [] });
    expect((await POST(request({ orderId: "missing" }))).status).toBe(404);
  });
});
