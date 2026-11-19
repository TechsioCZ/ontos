import { cleanup, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { browserAt, serveHttp } from "../support/http";
import { renderStorefront as render } from "../support/storefront";
import { LiveOrderStatus } from "@/features/checkout/live-order-status";

const orderId = "e12a77c6-c624-46bf-88fe-13d8c386e099";
const clientRequestId = "sf-12345678-1234-4234-8234-123456789abc";

describe("LiveOrderStatus", () => {
  it("shows the current owner status label from the BFF", async () => {
    const network = await serveHttp(() =>
      Response.json({
        statusLabel: "Zpracovává se",
        updatedAt: "2026-10-20T21:40:00.000Z",
        final: false,
      }),
    );
    try {
      browserAt(network.origin);
      render(<LiveOrderStatus orderId={orderId} clientRequestId={clientRequestId} />);
      expect(screen.getByText("Načítám aktuální stav objednávky…")).toBeDefined();
      await waitFor(() => expect(screen.getByText("Zpracovává se")).toBeDefined());
      expect(screen.getByText(/Aktuální stav v OntOS:/)).toBeDefined();
      await network.idle();
      const request = network.requests[0];
      expect(request).toBeDefined();
      if (!request) throw new Error("The rendered status did not send an HTTP request");
      expect(new URL(request.url).pathname).toBe("/api/ontos/order-status");
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual({ orderId, clientRequestId });
    } finally {
      cleanup();
      await network.idle();
      await network.close();
    }
  });
  it("explains a not-yet-known order and a failed read in Czech", async () => {
    let status = 404;
    const network = await serveHttp(() => Response.json({}, { status }));
    try {
      browserAt(network.origin);
      render(<LiveOrderStatus orderId={orderId} clientRequestId={clientRequestId} />);
      await waitFor(() =>
        expect(screen.getByText("Stav objednávky zatím není k dispozici.")).toBeDefined(),
      );
      cleanup();
      await network.idle();
      status = 503;
      render(<LiveOrderStatus orderId={orderId} clientRequestId={clientRequestId} />);
      await waitFor(() =>
        expect(
          screen.getByText("Aktuální stav objednávky se nepodařilo načíst. Zkusíme to znovu."),
        ).toBeDefined(),
      );
    } finally {
      cleanup();
      await network.idle();
      await network.close();
    }
  });
});
