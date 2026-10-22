import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckoutDraft } from "@/mock-storefront/checkout";
import { callAction } from "@/ontos/gateway";
import { POST } from "@/app/api/ontos/orders/route";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/catalog-server", () => ({ readProducts: async () => ({ revision: 7 }) }));
vi.mock("@/ontos/gateway", () => ({ callAction: vi.fn(), OntosError: class extends Error {} }));

const clientRequestId = "akros-12345678-1234-4234-8234-123456789abc";
async function submit(company = "Ukázková dílna") {
  const draft = { ...createCheckoutDraft(), deliveryId: "osobni", company };
  draft.email = "dilna@example.invalid";
  return POST(
    new Request("http://localhost:3070/api/ontos/orders", {
      method: "POST",
      headers: { origin: "http://localhost:3070", "content-type": "application/json" },
      body: JSON.stringify({
        clientRequestId,
        draft,
        cart: {
          version: 3,
          lines: [{ productId: "product-16732", quantity: 500, priceMinor: 105 }],
        },
      }),
    }),
  );
}

beforeEach(() => {
  vi.mocked(callAction).mockReset();
  vi.mocked(callAction).mockResolvedValue({
    storefrontOrder: {
      outcome: "PLACED",
      orderNumber: "OBJ-2026-0022",
      totalMinor: 52500,
      totalVatMinor: 9112,
    },
  });
});

describe("connected order note presentation", () => {
  it("places the order with the fresh revision and a Czech payment explanation", async () => {
    const response = await submit();
    expect(response.status).toBe(200);
    const payload = vi.mocked(callAction).mock.calls[0][2] as {
      command: { note: string; clientRequestId: string };
      expectedRevision: number;
    };
    expect(payload.command.note).toBe(
      "AKROS DEMO – objednávka nebude doručena. Platba se neprovádí (DEMO). Ukázková dílna",
    );
    expect(payload.command.clientRequestId).toBe(clientRequestId);
    expect(payload.expectedRevision).toBe(7);
  });

  it("retains the owner note length limit without truncating the demo explanation", async () => {
    expect((await submit("Ž".repeat(1200))).status).toBe(200);
    const payload = vi.mocked(callAction).mock.calls[0][2] as { command: { note: string } };
    expect(payload.command.note).toHaveLength(1000);
    expect(payload.command.note).toContain("Platba se neprovádí (DEMO).");
  });
});
