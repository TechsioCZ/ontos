import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrderConfirmation } from "@/features/checkout/order-confirmation";
import { CartProvider } from "@/features/cart/cart-provider";
import { GuestOrderConfirmation } from "@/features/checkout/guest-order-confirmation";
import type { CustomerOrder } from "@/ontos/order-model";

const savedOrder = {
  id: "saved-order-id",
  customerAccountId: "admitted-customer-id",
  number: "OBJ-2026-0042",
  status: "NEW",
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:00.000Z",
  totalMinor: 12_100,
  totalVatMinor: 2_100,
  contact: { name: "Petr Novák", email: "saved.recipient@example.test" },
  lines: [],
} satisfies CustomerOrder;

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("mounts one real receipt panel and polls with only the saved recipient and order number", async () => {
  vi.useFakeTimers();
  window.history.replaceState(
    null,
    "",
    "/potvrzeni-objednavky?email=query-recipient@example.test&orderNumber=OBJ-QUERY-999",
  );
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({
      deliveries: [{ event: "ORDER_CREATED", status: "SENT", sentAt: "2026-10-27T10:01:00.000Z" }],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await act(async () => {
    render(
      <CartProvider storage={null}>
        <OrderConfirmation order={savedOrder} />
      </CartProvider>,
    );
  });

  expect(screen.getAllByRole("region", { name: "E-maily k objednávce" })).toHaveLength(1);
  expect(screen.getByText("Potvrzení přijetí objednávky")).toBeDefined();
  expect(screen.getByText(/Odesláno e-mailem/)).toBeDefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/ontos/order-emails?email=saved.recipient%40example.test&orderNumber=OBJ-2026-0042",
    { cache: "no-store" },
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/ontos/order-emails?email=saved.recipient%40example.test&orderNumber=OBJ-2026-0042",
    { cache: "no-store" },
  );
});

it.each([undefined, ""])(
  "does not use a fallback or poll when the saved recipient is %s",
  async (email) => {
    vi.useFakeTimers();
    window.history.replaceState(
      null,
      "",
      "/potvrzeni-objednavky?email=query-recipient@example.test&orderNumber=OBJ-QUERY-999",
    );
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ deliveries: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const order: CustomerOrder = {
      ...savedOrder,
      contact: email === undefined ? undefined : { ...savedOrder.contact, email },
    };

    await act(async () => {
      render(
        <CartProvider storage={null}>
          <OrderConfirmation order={order} />
        </CartProvider>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(screen.queryByRole("region", { name: "E-maily k objednávce" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it("confirms a guest order from this tab's receipt with live status and e-mail receipts", async () => {
  window.sessionStorage.setItem(
    "akros-guest-order",
    JSON.stringify({
      orderId: "guest-order-1",
      orderNumber: "OBJ-2026-0100",
      clientRequestId: "akros-12345678-1234-4234-8234-123456789abc",
      email: "guest@example.test",
    }),
  );
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    String(input) === "/api/ontos/order-status"
      ? Response.json({ statusLabel: "Nová", updatedAt: "2026-10-27T10:00:00.000Z", final: false })
      : Response.json({ deliveries: [] }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await act(async () => {
    render(<GuestOrderConfirmation orderId="guest-order-1" />);
  });

  expect(
    screen.getByRole("heading", { name: "Objednávka č. OBJ-2026-0100 byla uložena do OntOS" }),
  ).toBeDefined();
  expect(screen.getByRole("region", { name: "E-maily k objednávce" })).toBeDefined();
  expect(fetchMock).toHaveBeenCalledWith("/api/ontos/order-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orderId: "guest-order-1",
      clientRequestId: "akros-12345678-1234-4234-8234-123456789abc",
    }),
    cache: "no-store",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/ontos/order-emails?email=guest%40example.test&orderNumber=OBJ-2026-0100",
    { cache: "no-store" },
  );
});

it("does not confirm a guest order that this tab did not place", async () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.setItem(
    "akros-guest-order",
    JSON.stringify({
      orderId: "other-order",
      orderNumber: "OBJ-2026-0101",
      clientRequestId: "akros-12345678-1234-4234-8234-123456789abc",
      email: "guest@example.test",
    }),
  );
  await act(async () => {
    render(<GuestOrderConfirmation orderId="guest-order-1" />);
  });
  expect(
    screen.getByRole("heading", { name: "Potvrzení objednávky zde není k dispozici" }),
  ).toBeDefined();
  expect(fetchMock).not.toHaveBeenCalled();
});
