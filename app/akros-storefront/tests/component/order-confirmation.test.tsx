import { setTimeout as delay } from "node:timers/promises";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { browserAt, serveHttp } from "../support/http";
import { renderStorefront as render } from "../support/storefront";
import { afterEach, beforeEach, expect, it } from "vitest";
import { OrderConfirmation } from "@/features/checkout/order-confirmation";
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

let network: Awaited<ReturnType<typeof serveHttp>>;
let emailStatus: number;

beforeEach(async () => {
  emailStatus = 200;
  network = await serveHttp((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/ontos/order-emails" && request.method === "GET") {
      return emailStatus === 200
        ? Response.json({
            deliveries: [
              { event: "ORDER_CREATED", status: "SENT", sentAt: "2026-10-27T10:01:00.000Z" },
            ],
          })
        : Response.json({ message: "unavailable" }, { status: emailStatus });
    }
    if (path === "/api/ontos/order-status" && request.method === "POST") {
      return Response.json({
        statusLabel: "Nová",
        updatedAt: "2026-10-27T10:00:00.000Z",
        final: false,
      });
    }
    return new Response("Unknown endpoint", { status: 404 });
  });
  browserAt(network.origin);
});

afterEach(async () => {
  cleanup();
  window.sessionStorage.clear();
  await network.idle();
  await network.close();
});

it("mounts one real receipt panel and polls with only the saved recipient and order number", async () => {
  browserAt(
    `${network.origin}/potvrzeni-objednavky?email=query-recipient@example.test&orderNumber=OBJ-QUERY-999`,
  );

  await act(async () => {
    render(<OrderConfirmation order={savedOrder} />);
  });

  expect(await screen.findByText(/Odesláno e-mailem/)).toBeDefined();
  await network.idle();
  expect(screen.getAllByRole("region", { name: "E-maily k objednávce" })).toHaveLength(1);
  expect(screen.getByText("Potvrzení přijetí objednávky")).toBeDefined();
  expect(screen.getByText(/Odesláno e-mailem/)).toBeDefined();
  expect(network.requests).toHaveLength(1);
  expect(network.requests[0]?.method).toBe("GET");
  expect(network.requests[0]?.url).toBe(
    `${network.origin}/api/ontos/order-emails?email=saved.recipient%40example.test&orderNumber=OBJ-2026-0042`,
  );

  await waitFor(() => expect(network.requests).toHaveLength(2), { timeout: 6_000 });
  await network.idle();

  expect(network.requests).toHaveLength(2);
  expect(network.requests[1]?.method).toBe("GET");
  expect(network.requests[1]?.url).toBe(
    `${network.origin}/api/ontos/order-emails?email=saved.recipient%40example.test&orderNumber=OBJ-2026-0042`,
  );
}, 15_000);

it("tells the customer calmly that the e-mail status will be retried when it cannot be loaded", async () => {
  emailStatus = 503;

  await act(async () => {
    render(<OrderConfirmation order={savedOrder} />);
  });

  expect(await screen.findByText(/zkusíme to znovu za chvíli/)).toBeDefined();
  expect(screen.queryByText(/nepodařilo ověřit/)).toBeNull();
});

it.each([undefined, ""])(
  "does not use a fallback or poll when the saved recipient is %s",
  async (email) => {
    browserAt(
      `${network.origin}/potvrzeni-objednavky?email=query-recipient@example.test&orderNumber=OBJ-QUERY-999`,
    );
    const order: CustomerOrder = {
      ...savedOrder,
      contact: email === undefined ? undefined : { ...savedOrder.contact, email },
    };

    await act(async () => {
      render(<OrderConfirmation order={order} />);
    });
    await act(async () => {
      await delay(8_100);
      await network.idle();
    });

    expect(screen.queryByRole("region", { name: "E-maily k objednávce" })).toBeNull();
    expect(network.requests).toHaveLength(0);
  },
  15_000,
);

it("confirms a guest order from this tab's receipt with live status and e-mail receipts", async () => {
  window.sessionStorage.setItem(
    "sf-guest-order",
    JSON.stringify({
      orderId: "guest-order-1",
      orderNumber: "OBJ-2026-0100",
      clientRequestId: "sf-12345678-1234-4234-8234-123456789abc",
      email: "guest@example.test",
    }),
  );
  await act(async () => {
    render(<GuestOrderConfirmation orderId="guest-order-1" />);
  });

  expect(
    screen.getByRole("heading", { name: "Objednávka č. OBJ-2026-0100 byla uložena do OntOS" }),
  ).toBeDefined();
  expect(screen.getByRole("region", { name: "E-maily k objednávce" })).toBeDefined();
  expect(await screen.findByText("Nová")).toBeDefined();
  expect(await screen.findByText("Potvrzení přijetí objednávky")).toBeDefined();
  await network.idle();
  expect(network.requests).toHaveLength(2);
  const statusRequest = network.requests.find(
    (request) => new URL(request.url).pathname === "/api/ontos/order-status",
  );
  expect(statusRequest?.method).toBe("POST");
  expect(statusRequest?.headers.get("content-type")).toBe("application/json");
  expect(await statusRequest?.json()).toEqual({
    orderId: "guest-order-1",
    clientRequestId: "sf-12345678-1234-4234-8234-123456789abc",
  });
  const emailRequest = network.requests.find(
    (request) => new URL(request.url).pathname === "/api/ontos/order-emails",
  );
  expect(emailRequest?.method).toBe("GET");
  expect(emailRequest?.url).toBe(
    `${network.origin}/api/ontos/order-emails?email=guest%40example.test&orderNumber=OBJ-2026-0100`,
  );
});

it("does not confirm a guest order that this tab did not place", async () => {
  window.sessionStorage.setItem(
    "sf-guest-order",
    JSON.stringify({
      orderId: "other-order",
      orderNumber: "OBJ-2026-0101",
      clientRequestId: "sf-12345678-1234-4234-8234-123456789abc",
      email: "guest@example.test",
    }),
  );
  await act(async () => {
    render(<GuestOrderConfirmation orderId="guest-order-1" />);
  });
  expect(
    screen.getByRole("heading", { name: "Potvrzení objednávky zde není k dispozici" }),
  ).toBeDefined();
  await network.idle();
  expect(network.requests).toHaveLength(0);
});
