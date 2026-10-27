import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrderConfirmation } from "@/features/checkout/order-confirmation";
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
    render(<OrderConfirmation order={savedOrder} />);
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
      render(<OrderConfirmation order={order} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(screen.queryByRole("region", { name: "E-maily k objednávce" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
