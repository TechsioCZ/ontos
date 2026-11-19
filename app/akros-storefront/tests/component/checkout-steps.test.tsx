import { settleBrowser } from "../support/browser";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "next/dist/client/app-bootstrap";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { publicAppRouterInstance } from "next/dist/client/components/app-router-instance";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CartProvider } from "@/features/cart/cart-provider";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";
import { CartQuoteProvider } from "@/ontos/cart-revalidation";
import { DeliveryPaymentStep } from "@/features/checkout/delivery-payment-step";
import { AddressStep } from "@/features/checkout/address-step";
import type { ReactNode } from "react";
import { browserAt, serveHttp } from "../support/http";
import { NextRouter } from "../support/router";
let network: Awaited<ReturnType<typeof serveHttp>>;
afterEach(async () => {
  cleanup();
  await network.idle();
  await network.close();
});
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  network = await serveHttp((request) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/ontos/checkout")
      return Response.json({
        shippingMethods: [{ id: "PPL", title: "Owner shipping", priceMinor: 12900 }],
      });
    if (request.method === "GET" && pathname === "/api/ontos/account")
      return Response.json({ account: null });
    if (request.method === "GET" && pathname === "/kosik/dodaci-udaje")
      return new Response("<!doctype html><title>Dodací údaje</title>", {
        headers: { "content-type": "text/html" },
      });
    return new Response("Unknown endpoint", { status: 404 });
  });
  browserAt(`${network.origin}/kosik/doprava-platba`);
});
async function renderStep(child: ReactNode) {
  await act(async () => {
    render(
      <CartProvider storage={null}>
        <CheckoutProvider>
          <CartQuoteProvider>{child}</CartQuoteProvider>
        </CheckoutProvider>
      </CartProvider>,
    );
  });
}
it("offers only owner shipping tariffs and never fictitious pickup locations or payment methods", async () => {
  const user = userEvent.setup();
  await renderStep(
    <NextRouter>
      <DeliveryPaymentStep />
    </NextRouter>,
  );
  const radio = await screen.findByRole("radio", { name: /Owner shipping/ });
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText("Objednávka bez online platby")).toBeTruthy();
  await user.click(radio);
  await act(async () => {
    await user.click(screen.getByRole("button", { name: "Dodací údaje" }));
  });
  await waitFor(() => expect(window.location.pathname).toBe("/kosik/dodaci-udaje"));
  await settleBrowser();
  expect(
    network.requests.some((request) => new URL(request.url).pathname === "/kosik/dodaci-udaje"),
  ).toBe(true);
});
it("shows initially empty editable addresses and blocks incomplete delivery data", async () => {
  const user = userEvent.setup();
  await renderStep(
    <AppRouterContext.Provider value={publicAppRouterInstance}>
      <AddressStep />
    </AppRouterContext.Provider>,
  );
  const email = screen.getByLabelText(/E-mail/);
  expect(email).toHaveProperty("value", "");
  const initialPath = window.location.pathname;
  await user.click(screen.getByRole("button", { name: "Souhrn objednávky" }));
  expect(screen.getByText("Zadejte platný e-mail.")).toBeTruthy();
  await settleBrowser();
  expect(window.location.pathname).toBe(initialPath);
  expect(
    network.requests.some((request) => new URL(request.url).pathname === "/kosik/shrnuti"),
  ).toBe(false);
  await user.type(email, "entered@example.test");
  expect(JSON.parse(sessionStorage.getItem("sf-checkout-v2")!).draft.email).toBe(
    "entered@example.test",
  );
});
