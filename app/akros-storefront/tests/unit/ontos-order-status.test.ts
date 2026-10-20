import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRecords } from "@/ontos/gateway";
import { POST } from "@/app/api/ontos/order-status/route";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/config", () => ({ isOntos: () => true }));
vi.mock("@/ontos/gateway", () => ({ readRecords: vi.fn() }));

const orderId = "e12a77c6-c624-46bf-88fe-13d8c386e099";
const clientRequestId = "akros-12345678-1234-4234-8234-123456789abc";
const ask = (body: unknown, origin = "http://localhost:3070") =>
  POST(
    new Request("http://localhost:3070/api/ontos/order-status", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.mocked(readRecords).mockReset();
  vi.mocked(readRecords).mockResolvedValue({
    orderStatus: {
      id: orderId,
      number: "OBJ-2026-0031",
      status: "PACKING",
      updatedAt: "2026-10-20T21:40:00.000Z",
    },
  });
});

describe("live order status BFF", () => {
  it("reads only the owner storefrontOrderStatus view and returns a Czech label", async () => {
    const response = await ask({ orderId, clientRequestId });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      id: orderId,
      number: "OBJ-2026-0031",
      status: "PACKING",
      statusLabel: "Připravená k předání",
      updatedAt: "2026-10-20T21:40:00.000Z",
      final: false,
    });
    expect(readRecords).toHaveBeenCalledWith("merchandise", "records", {
      view: { storefront: true, storefrontOrderStatus: { orderId, clientRequestId } },
    });
  });
  it("marks delivered and cancelled orders as final", async () => {
    vi.mocked(readRecords).mockResolvedValue({
      orderStatus: {
        id: orderId,
        number: "OBJ-2026-0031",
        status: "CANCELLED",
        updatedAt: "2026-10-20T21:40:00.000Z",
      },
    });
    expect(await (await ask({ orderId, clientRequestId })).json()).toMatchObject({
      statusLabel: "Stornovaná",
      final: true,
    });
  });
  it.each([
    [{ orderId, clientRequestId: "bad" }],
    [{ orderId: "x", clientRequestId }],
    [{ clientRequestId }],
  ])("rejects invalid input %j without reading OntOS", async (body) => {
    expect((await ask(body)).status).toBe(400);
    expect(readRecords).not.toHaveBeenCalled();
  });
  it.each([
    { orderStatus: null },
    { orderStatus: { id: "other-order-id", number: "X", status: "NEW", updatedAt: "x" } },
    { orderStatus: { id: orderId, number: "X", status: "LOST", updatedAt: "x" } },
  ])("answers 404 for an unknown or malformed owner answer %j", async (owner) => {
    vi.mocked(readRecords).mockResolvedValue(owner);
    expect((await ask({ orderId, clientRequestId })).status).toBe(404);
  });
  it("refuses cross-origin calls", async () => {
    expect((await ask({ orderId, clientRequestId }, "https://evil.example")).status).toBe(503);
  });
});
