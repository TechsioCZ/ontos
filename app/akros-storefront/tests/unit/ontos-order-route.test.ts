import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckoutDraft } from "@/features/checkout/checkout-state";
import { callAction, readRecords } from "@/ontos/gateway";
import { readAccount } from "@/ontos/account";
import { GET, POST } from "@/app/api/ontos/orders/route";

vi.mock("@/ontos/account", () => ({ readAccount: vi.fn() }));
vi.mock("@/ontos/catalog-server", () => ({ readProducts: async () => ({ revision: 7 }) }));
vi.mock("@/ontos/gateway", () => ({
  callAction: vi.fn(),
  readRecords: vi.fn(),
  OntosError: class extends Error {},
}));
const account = {
  id: "portal-customer-1",
  tenantId: "admitted-tenant",
  partyId: "admitted-party-1",
  email: "verified@example.test",
  name: "Customer",
};
const clientRequestId = "akros-12345678-1234-4234-8234-123456789abc";
async function submit(company = "Company", deliveryId = "PPL") {
  const draft = {
    ...createCheckoutDraft(),
    deliveryId,
    company,
    email: "forged@example.test",
    billing: {
      firstName: "Customer",
      lastName: "Test",
      street: "Test 1",
      city: "Brno",
      postalCode: "60200",
      country: "CZ",
      phone: "+420777123456",
    },
  };
  return POST(
    new Request("http://localhost:3070/api/ontos/orders", {
      method: "POST",
      headers: {
        origin: "http://localhost:3070",
        "content-type": "application/json",
        cookie: "commerce-portal.session_token=admitted",
      },
      body: JSON.stringify({
        customerAccountId: "attacker",
        clientRequestId,
        draft,
        cart: { version: 3, lines: [{ productId: "product-1", quantity: 5, priceMinor: 105 }] },
      }),
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readAccount).mockResolvedValue(account);
  vi.mocked(readRecords).mockResolvedValue({
    checkout: {
      shippingMethods: [{ id: "PPL", title: "PPL", priceMinor: 12900 }],
      paymentAvailable: false,
      carrierTrackingAvailable: false,
    },
  });
  vi.mocked(callAction).mockResolvedValue({
    storefrontOrder: {
      outcome: "PLACED",
      orderId: "order-1",
      orderNumber: "OBJ-2026-0022",
      totalMinor: 13425,
      totalVatMinor: 2330,
    },
  });
});
describe("real order boundary", () => {
  it("places against fresh revision using admitted identity and owner shipping prices, not browser identity", async () => {
    expect((await submit()).status).toBe(200);
    expect(readAccount).toHaveBeenCalledWith(
      "http://localhost:3070",
      "commerce-portal.session_token=admitted",
    );
    const payload = vi.mocked(callAction).mock.calls[0][2];
    expect(payload).toMatchObject({
      expectedRevision: 7,
      command: {
        customerAccountId: account.id,
        partyId: account.partyId,
        contact: { email: account.email },
        clientRequestId,
        shippingMethod: "PPL",
        expectedShippingPriceMinor: 12900,
        note: "Company",
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/DEMO|simulace|forged|attacker/);
  });
  it("requires authentication before reading prices or writing an order", async () => {
    vi.mocked(readAccount).mockResolvedValue(null);
    expect((await submit()).status).toBe(401);
    expect(readRecords).not.toHaveBeenCalled();
    expect(callAction).not.toHaveBeenCalled();
  });
  it("rejects a delivery method absent from the current owner configuration", async () => {
    expect((await submit("Company", "zasilkovna")).status).toBe(400);
    expect(callAction).not.toHaveBeenCalled();
  });
  it("retains customer note length limit without inserting a simulation disclaimer", async () => {
    expect((await submit("Ž".repeat(1200))).status).toBe(200);
    expect(
      (vi.mocked(callAction).mock.calls[0][2] as { command: { note: string } }).command.note,
    ).toHaveLength(1000);
  });
  it("queries customer orders using only session subject, ignoring a forged query subject", async () => {
    vi.mocked(readRecords).mockResolvedValue({ orders: [], totalOrders: 0 });
    const response = await GET(
      new Request(
        "http://localhost:3070/api/ontos/orders?customerAccountId=attacker&order=other-order",
      ),
    );
    expect(response.status).toBe(200);
    expect(readRecords).toHaveBeenCalledWith("merchandise", "records", {
      view: {
        storefront: true,
        storefrontCustomerOrders: {
          customerAccountId: account.id,
          orderId: "other-order",
          offset: 0,
        },
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("fails closed if the owner returns another customer's receipt", async () => {
    vi.mocked(readRecords).mockResolvedValue({
      orders: [{ customerAccountId: "attacker" }],
      totalOrders: 1,
    });
    expect((await GET(new Request("http://localhost:3070/api/ontos/orders"))).status).toBe(503);
  });
});
