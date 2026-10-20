import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutProvider, useCheckout } from "@/features/checkout/checkout-provider";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { createCheckoutDraft } from "@/mock-storefront/checkout";
import { checkoutSaveError } from "@/ontos/checkout-response";
vi.mock("@/ontos/catalog-provider", () => ({ useDataSource: () => "ontos" }));

function Probe() {
  const { ready, storageError, draft, completeOrder } = useCheckout();
  const { cart } = useCart();
  return (
    <>
      <output aria-label="Ready">{String(ready)}</output>
      <output aria-label="Cart">{cart.lines.length}</output>
      <output aria-label="Error">{storageError}</output>
      <output aria-label="Payment">{draft.paymentId}</output>
      <button onClick={() => completeOrder()}>Submit</button>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(
    "akros-demo-cart-v3",
    JSON.stringify({
      version: 3,
      lines: [
        {
          productId: "p",
          slug: "p",
          name: "Šroub",
          sku: "s",
          imageSrc: "/s.jpg",
          imageAlt: "Šroub",
          unit: "ks",
          minimumQuantity: 1,
          stockCount: 100,
          priceMinor: 121,
          priceExcludingVatMinor: 100,
          quantity: 1,
        },
      ],
    }),
  );
  sessionStorage.setItem(
    "akros-demo-checkout-v1",
    JSON.stringify({
      version: 1,
      draft: { ...createCheckoutDraft(), deliveryId: "osobni", paymentId: "gopay" },
    }),
  );
});
describe("OntOS submission recovery", () => {
  it.each(["http", "json-shape", "invalid-json", "network"])(
    "keeps the cart and exact pending ID after %s failure, then safely retries",
    async (failure) => {
      const user = userEvent.setup();
      const requests: string[] = [];
      let attempted = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, options: RequestInit) => {
          if (url.endsWith("/cart"))
            return Response.json({ canCheckout: true, priceChanged: false, issues: [] });
          requests.push(String(options.body));
          if (!attempted) {
            attempted = true;
            if (failure === "network") throw new TypeError("Failed to fetch");
            if (failure === "http") return Response.json({ error: "unavailable" }, { status: 503 });
            if (failure === "json-shape") return Response.json({});
            return new Response("broken JSON");
          }
          return Response.json({
            outcome: "REPLAYED",
            orderNumber: "OBJ-2026-0099",
            totalMinor: 121,
            totalVatMinor: 21,
          });
        }),
      );
      render(
        <CartProvider>
          <CheckoutProvider>
            <Probe />
          </CheckoutProvider>
        </CartProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText("Ready").textContent).toBe("true"));
      expect(screen.getByLabelText("Payment").textContent).toBe("demo-no-payment");
      await user.click(screen.getByText("Submit"));
      await waitFor(() =>
        expect(screen.getByLabelText("Error").textContent).toBe(checkoutSaveError),
      );
      expect(screen.getByLabelText("Cart").textContent).toBe("1");
      expect(sessionStorage.getItem("akros-demo-order-v1")).toBeNull();
      await user.click(screen.getByText("Submit"));
      await waitFor(() => expect(screen.getByLabelText("Cart").textContent).toBe("0"));
      expect(requests).toHaveLength(2);
      expect(requests[0]).toBe(requests[1]);
      expect(JSON.parse(sessionStorage.getItem("akros-demo-order-v1")!)).toMatchObject({
        id: "OBJ-2026-0099",
        source: "ontos",
        paymentTitle: "Nic neplatíte (DEMO)",
      });
    },
  );
});
