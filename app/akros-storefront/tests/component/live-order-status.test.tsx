import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveOrderStatus } from "@/features/checkout/live-order-status";

const orderId = "e12a77c6-c624-46bf-88fe-13d8c386e099";
const clientRequestId = "akros-12345678-1234-4234-8234-123456789abc";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LiveOrderStatus", () => {
  it("shows the current owner status label from the BFF", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        statusLabel: "Zpracovává se",
        updatedAt: "2026-10-20T21:40:00.000Z",
        final: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveOrderStatus orderId={orderId} clientRequestId={clientRequestId} />);
    expect(screen.getByText("Načítám aktuální stav objednávky…")).toBeDefined();
    await waitFor(() => expect(screen.getByText("Zpracovává se")).toBeDefined());
    expect(screen.getByText(/Aktuální stav v OntOS:/)).toBeDefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ontos/order-status");
    expect(JSON.parse(String(init.body))).toEqual({ orderId, clientRequestId });
  });
  it("explains a not-yet-known order and a failed read in Czech", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 404 })),
    );
    render(<LiveOrderStatus orderId={orderId} clientRequestId={clientRequestId} />);
    await waitFor(() =>
      expect(screen.getByText("Stav objednávky zatím není k dispozici.")).toBeDefined(),
    );
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status: 503 })),
    );
    render(<LiveOrderStatus orderId={orderId} clientRequestId={clientRequestId} />);
    await waitFor(() =>
      expect(
        screen.getByText("Aktuální stav objednávky se nepodařilo načíst. Zkusíme to znovu."),
      ).toBeDefined(),
    );
  });
});
