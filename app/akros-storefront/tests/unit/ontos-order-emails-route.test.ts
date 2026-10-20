import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/ontos/order-emails/route";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/config", () => ({ isOntos: () => true }));

const fetchMock = vi.fn();
function get(orderNumber: string) {
  return GET(new Request(`http://localhost:3070/api/ontos/order-emails?orderNumber=${encodeURIComponent(orderNumber)}`));
}

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("order e-mail status route", () => {
  it("returns only the allowed receipt fields from the dispatcher", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(
      Response.json({
        deliveries: [
          {
            event: "ORDER_CREATED",
            status: "SENT",
            sentAt: "2026-10-21T08:41:00.000Z",
            subjectId: "x",
            recipient: "leak@x.cz",
          },
        ],
      }),
    );
    const response = await get("OBJ-2026-0026");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deliveries: [{ event: "ORDER_CREATED", status: "SENT", sentAt: "2026-10-21T08:41:00.000Z" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3096/v1/deliveries?source=akros-order&subjectNumber=OBJ-2026-0026",
      expect.anything(),
    );
  });

  it("rejects malformed order numbers without calling the dispatcher", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const response = await get("x");
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 with a Czech message when the dispatcher is unreachable", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const response = await get("OBJ-2026-0026");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "Stav e-mailů se nepodařilo ověřit." });
  });
});
