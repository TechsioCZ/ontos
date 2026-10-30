import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/ontos/orders/reorder/route";
import { readAccount } from "@/ontos/account";
import { readCustomerOrders } from "@/ontos/customer-orders";
import { readCartProducts } from "@/ontos/catalog-server";
import type { CustomerOrder } from "@/ontos/order-model";
import { fixtureProducts } from "../support/catalog-fixture";

vi.mock("@/ontos/account", () => ({ readAccount: vi.fn<typeof readAccount>() }));
vi.mock("@/ontos/customer-orders", () => ({
  readCustomerOrders: vi.fn<typeof readCustomerOrders>(),
}));
vi.mock("@/ontos/catalog-server", () => ({ readCartProducts: vi.fn<typeof readCartProducts>() }));

const account = {
  id: "customer",
  tenantId: "tenant",
  partyId: "party",
  email: "user@example.test",
  name: "Customer",
};
const product = fixtureProducts.find((item) => item.detail.variants.length > 3)!;
const variant = {
  ...product.detail.variants[0],
  priceMinor: 500,
  stockCount: 60,
  minimumQuantity: 20,
  quantityStep: 20,
  priceTiers: [{ minimumQuantity: 20, priceMinor: 500, priceExcludingVatMinor: 413 }],
};
const order: CustomerOrder = {
  id: "order-1",
  customerAccountId: account.id,
  number: "2026-01",
  status: "DELIVERED",
  createdAt: "2026-10-20T12:00:00Z",
  updatedAt: "2026-10-20T12:00:00Z",
  totalMinor: 100,
  totalVatMinor: 17,
  lines: [
    {
      productId: product.id,
      variantId: variant.id,
      productName: "Historical name",
      sku: "old-sku",
      quantity: 100,
      unitPriceMinor: 1,
      vatRate: 21,
    },
  ],
};
const request = (query = "order=order-1") =>
  new Request(`http://localhost:3070/api/ontos/orders/reorder?${query}`, {
    headers: { cookie: "commerce-portal.session_token=admitted" },
  });
const page = { revision: 7, total: 1, page: 1, pageSize: 100, homepageFeaturedProductIds: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readAccount).mockResolvedValue(account);
  vi.mocked(readCustomerOrders).mockResolvedValue({ orders: [order], total: 1 });
  vi.mocked(readCartProducts).mockResolvedValue({
    ...page,
    products: [{ ...product, detail: { ...product.detail, variants: [variant] } }],
  });
});

describe("preparing a native reorder", () => {
  it("requires an admitted account before reading orders or offers", async () => {
    vi.mocked(readAccount).mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(readCustomerOrders).not.toHaveBeenCalled();
    expect(readCartProducts).not.toHaveBeenCalled();
  });
  it("uses only the account's exact order and forwards its session", async () => {
    expect((await GET(request("order=other"))).status).toBe(404);
    expect(readAccount).toHaveBeenCalledWith(
      "http://localhost:3070",
      "commerce-portal.session_token=admitted",
    );
    expect(readCustomerOrders).toHaveBeenCalledWith(account, "other");
    expect(readCartProducts).not.toHaveBeenCalled();
    expect((await GET(request(""))).status).toBe(400);
  });
  it("uses current variant prices, stock and package rules, never historical prices", async () => {
    const response = await GET(request());
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result).toMatchObject({
      skipped: 0,
      adjusted: 1,
      items: [
        {
          quantity: 60,
          item: {
            productId: product.id,
            variantId: variant.id,
            priceMinor: 500,
            minimumQuantity: 20,
            quantityStep: 20,
            stockCount: 60,
          },
          priceTiers: variant.priceTiers,
        },
      ],
    });
    expect(result.items[0].item.sku).toBe(variant.sku);
  });
  it.each([
    { stockCount: 0 },
    { availabilityUnknown: true },
    { priceUnavailableReason: "MISSING" },
    { priceMinor: 0 },
    { id: "different-variant" },
  ])("skips an unavailable exact offer: %j", async (change) => {
    vi.mocked(readCartProducts).mockResolvedValue({
      ...page,
      products: [
        { ...product, detail: { ...product.detail, variants: [{ ...variant, ...change }] } },
      ],
    });
    expect(await (await GET(request())).json()).toEqual({ items: [], skipped: 1, adjusted: 0 });
  });
  it("returns partial results without substituting a missing variant", async () => {
    vi.mocked(readCustomerOrders).mockResolvedValue({
      orders: [{ ...order, lines: [...order.lines, { ...order.lines[0], variantId: "deleted" }] }],
      total: 1,
    });
    const result = await (await GET(request())).json();
    expect(result.items).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });
  it("refuses to turn a group container into a purchasable variant", async () => {
    vi.mocked(readCustomerOrders).mockResolvedValue({
      orders: [{ ...order, lines: [{ ...order.lines[0], variantId: undefined }] }],
      total: 1,
    });
    expect(await (await GET(request())).json()).toEqual({ items: [], skipped: 1, adjusted: 0 });
  });
});
