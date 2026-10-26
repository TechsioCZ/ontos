import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutProvider, useCheckout } from "@/features/checkout/checkout-provider";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { createCheckoutDraft } from "@/features/checkout/checkout-state";
import { cartCollectionStorageKey, createCartCollection } from "@/features/cart/cart-collection";
import { checkoutSaveError } from "@/ontos/checkout-response";

function Probe() {
  const { ready, accountEmail, methods, storageError, draft, completeOrder } = useCheckout();
  const { cart, activeCartId, selectCart } = useCart();
  return (
    <>
      <output aria-label="Ready">{String(ready && !!accountEmail && !!methods.length)}</output>
      <output aria-label="Cart">{cart.lines.length}</output>
      <output aria-label="Active cart">{activeCartId}</output>
      <button onClick={() => selectCart("default")}>Default cart</button>
      <button onClick={() => selectCart("commission")}>Commission cart</button>
      <output aria-label="Error">{storageError}</output>
      <output aria-label="Delivery">{draft.deliveryId}</output>
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
    "akros-checkout-v2",
    JSON.stringify({
      version: 1,
      draft: {
        ...createCheckoutDraft(),
        deliveryId: "PPL",
        email: "verified@example.test",
        billing: {
          firstName: "Test",
          lastName: "Customer",
          street: "Test 1",
          city: "Brno",
          postalCode: "60200",
          country: "CZ",
          phone: "+420777123456",
        },
      },
    }),
  );
});
describe("OntOS submission recovery", () => {
  it("clears only the submitted cart after switching carts during an order request", async () => {
    const user = userEvent.setup();
    const cart = JSON.parse(localStorage.getItem("akros-demo-cart-v3") ?? "null");
    const collection = createCartCollection(cart);
    collection.carts[1].cart = { ...cart, lines: [{ ...cart.lines[0], quantity: 3 }] };
    localStorage.setItem(cartCollectionStorageKey, JSON.stringify({ version: 1, ...collection }));
    const pendingOrder = Promise.withResolvers<Response>();
    const fetchOrder = vi.fn(() => pendingOrder.promise);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/checkout"))
          return Response.json({
            shippingMethods: [{ id: "PPL", title: "PPL", priceMinor: 12900 }],
          });
        if (url.endsWith("/account"))
          return Response.json({ account: { email: "verified@example.test", name: "Customer" } });
        if (url.endsWith("/cart"))
          return Response.json({ canCheckout: true, priceChanged: false, issues: [] });
        return fetchOrder();
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
    await user.click(screen.getByText("Submit"));
    await waitFor(() => expect(fetchOrder).toHaveBeenCalledOnce());
    await user.click(screen.getByText("Commission cart"));
    expect(screen.getByLabelText("Active cart").textContent).toBe("commission");
    await act(async () => {
      pendingOrder.resolve(
        Response.json({
          outcome: "PLACED",
          orderId: "order-persisted-1",
          orderNumber: "OBJ-2026-0099",
          totalMinor: 121,
          totalVatMinor: 21,
        }),
      );
    });
    expect(screen.getByLabelText("Cart").textContent).toBe("1");
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(cartCollectionStorageKey) ?? "null");
      expect(stored.activeCartId).toBe("commission");
      expect(stored.carts[0].cart.lines).toEqual([]);
      expect(stored.carts[1].cart.lines[0].quantity).toBe(3);
    });
    await user.click(screen.getByText("Default cart"));
    expect(screen.getByLabelText("Cart").textContent).toBe("0");
    await user.click(screen.getByText("Commission cart"));
    expect(screen.getByLabelText("Cart").textContent).toBe("1");
  });

  it.each(["http", "json-shape", "invalid-json", "network"])(
    "keeps the cart and exact pending ID after %s failure, then safely retries",
    async (failure) => {
      const user = userEvent.setup();
      const requests: string[] = [];
      let attempted = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, options: { body: string }) => {
          if (url.endsWith("/checkout"))
            return Response.json({
              shippingMethods: [{ id: "PPL", title: "PPL", priceMinor: 12900 }],
            });
          if (url.endsWith("/account"))
            return Response.json({ account: { email: "verified@example.test", name: "Customer" } });
          if (url.endsWith("/cart"))
            return Response.json({ canCheckout: true, priceChanged: false, issues: [] });
          requests.push(options.body);
          if (!attempted) {
            attempted = true;
            if (failure === "network") throw new TypeError("Failed to fetch");
            if (failure === "http") return Response.json({ error: "unavailable" }, { status: 503 });
            if (failure === "json-shape") return Response.json({});
            return new Response("broken JSON");
          }
          return Response.json({
            outcome: "REPLAYED",
            orderId: "order-persisted-1",
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
      expect(screen.getByLabelText("Delivery").textContent).toBe("PPL");
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
      expect(sessionStorage.getItem("akros-demo-order-v1")).toBeNull();
    },
  );
});
