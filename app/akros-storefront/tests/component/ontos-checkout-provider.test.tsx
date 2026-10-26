import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutProvider, useCheckout } from "@/features/checkout/checkout-provider";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { type CheckoutDraft, createCheckoutDraft } from "@/features/checkout/checkout-state";
import type { CartLine } from "@/features/cart/cart-state";
import { cartCollectionStorageKey, createCartCollection } from "@/features/cart/cart-collection";
import { checkoutSaveError } from "@/ontos/checkout-response";

function Probe({
  lineChange,
  draftChange,
}: {
  lineChange?: Partial<CartLine>;
  draftChange?: Partial<CheckoutDraft>;
}) {
  const {
    ready,
    accountEmail,
    methods,
    storageError,
    draft,
    completeOrder,
    updateDraft,
    submitted,
  } = useCheckout();
  const { cart, activeCartId, selectCart, dispatch } = useCart();
  return (
    <>
      <output aria-label="Ready">{String(ready && !!accountEmail && !!methods.length)}</output>
      <output aria-label="Cart">{cart.lines.length}</output>
      <output aria-label="Stock">{cart.lines[0]?.stockCount}</output>
      <output aria-label="Submitted">{String(submitted)}</output>
      <button
        onClick={() => {
          if (lineChange)
            dispatch({
              type: "revalidate",
              cart: { ...cart, lines: cart.lines.map((line) => ({ ...line, ...lineChange })) },
            });
          if (draftChange) updateDraft((current) => ({ ...current, ...draftChange }));
        }}
      >
        Edit order
      </button>
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
  it.each<{
    name: string;
    lineChange?: Partial<CartLine>;
    draftChange?: Partial<CheckoutDraft>;
  }>([
    { name: "quantity", lineChange: { quantity: 2 } },
    { name: "accepted price", lineChange: { priceMinor: 242 } },
    { name: "product", lineChange: { productId: "other" } },
    { name: "variant", lineChange: { variantId: "other" } },
    { name: "shipping", draftChange: { deliveryId: "DPD" } },
    { name: "company note", draftChange: { company: "Other company" } },
    {
      name: "delivery recipient",
      draftChange: {
        differentDeliveryAddress: true,
        delivery: {
          firstName: "Other",
          lastName: "Recipient",
          street: "Other 2",
          city: "Praha",
          postalCode: "11000",
          country: "CZ",
          phone: "+420777123457",
        },
      },
    },
    {
      name: "billing address",
      draftChange: {
        billing: {
          firstName: "Test",
          lastName: "Customer",
          street: "Other 2",
          city: "Brno",
          postalCode: "60200",
          country: "CZ",
          phone: "+420777123456",
        },
      },
    },
  ])(
    "blocks $name edits without replacing an uncertain request",
    async ({ lineChange, draftChange }) => {
      const user = userEvent.setup();
      const originalCart = JSON.parse(localStorage.getItem("akros-demo-cart-v3") ?? "null");
      const originalDraft = JSON.parse(sessionStorage.getItem("akros-checkout-v2") ?? "null").draft;
      const requests: string[] = [];
      let quoteChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, options: { body: string }) => {
          if (url.endsWith("/checkout"))
            return Response.json({
              shippingMethods: [
                { id: "PPL", title: "PPL", priceMinor: 12900 },
                { id: "DPD", title: "DPD", priceMinor: 12900 },
              ],
            });
          if (url.endsWith("/account"))
            return Response.json({ account: { email: "verified@example.test" } });
          if (url.endsWith("/cart")) {
            quoteChecks++;
            return Response.json({ canCheckout: true, priceChanged: false, issues: [] });
          }
          requests.push(options.body);
          if (requests.length === 1) throw new TypeError("Lost response");
          return Response.json({
            outcome: "REPLAYED",
            orderId: "order-1",
            orderNumber: "OBJ-1",
            totalMinor: 121,
            totalVatMinor: 21,
          });
        }),
      );
      const view = render(
        <CartProvider>
          <CheckoutProvider>
            <Probe lineChange={lineChange} draftChange={draftChange} />
          </CheckoutProvider>
        </CartProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText("Ready").textContent).toBe("true"));
      await user.click(screen.getByText("Submit"));
      await waitFor(() =>
        expect(screen.getByLabelText("Error").textContent).toBe(checkoutSaveError),
      );
      const pending = sessionStorage.getItem("akros-ontos-pending:default");
      await user.click(screen.getByText("Edit order"));
      await user.click(screen.getByText("Submit"));
      expect(screen.getByLabelText("Error").textContent).toContain(
        "Předchozí objednávka zatím nebyla potvrzena.",
      );
      expect(screen.getByLabelText("Submitted").textContent).toBe("false");
      expect(screen.getByLabelText("Cart").textContent).toBe("1");
      expect(requests).toHaveLength(1);
      expect(quoteChecks).toBe(1);
      expect(sessionStorage.getItem("akros-ontos-pending:default")).toBe(pending);
      view.rerender(
        <CartProvider>
          <CheckoutProvider>
            <Probe
              lineChange={{ variantId: undefined, ...originalCart.lines[0] }}
              draftChange={originalDraft}
            />
          </CheckoutProvider>
        </CartProvider>,
      );
      await user.click(screen.getByText("Edit order"));
      await user.click(screen.getByText("Submit"));
      await waitFor(() => expect(screen.getByLabelText("Submitted").textContent).toBe("true"));
      expect(requests).toEqual([requests[0], requests[0]]);
      expect(quoteChecks).toBe(1);
    },
  );

  it.each(["quote", "stock", "price"])(
    "allows semantic edits after a confirmed %s rejection",
    async (rejection) => {
      const user = userEvent.setup();
      const requests: string[] = [];
      let quoteChecks = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, options: { body: string }) => {
          if (url.endsWith("/checkout"))
            return Response.json({
              shippingMethods: [{ id: "PPL", title: "PPL", priceMinor: 12900 }],
            });
          if (url.endsWith("/account"))
            return Response.json({ account: { email: "verified@example.test" } });
          if (url.endsWith("/cart")) {
            quoteChecks++;
            const blocked = rejection === "quote" && quoteChecks === 1;
            return Response.json({
              canCheckout: !blocked,
              priceChanged: false,
              issues: blocked ? ["Unavailable"] : [],
            });
          }
          requests.push(options.body);
          if (rejection !== "quote" && requests.length === 1)
            return Response.json(
              {
                issues: [
                  {
                    code: rejection === "stock" ? "INSUFFICIENT_STOCK" : "PRICE_CHANGED",
                    message: "Rejected",
                  },
                ],
              },
              { status: 409 },
            );
          return Response.json({
            outcome: "PLACED",
            orderId: "order-2",
            orderNumber: "OBJ-2",
            totalMinor: 242,
            totalVatMinor: 42,
          });
        }),
      );
      render(
        <CartProvider>
          <CheckoutProvider>
            <Probe lineChange={{ quantity: 2 }} />
          </CheckoutProvider>
        </CartProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText("Ready").textContent).toBe("true"));
      await user.click(screen.getByText("Submit"));
      await waitFor(() => expect(screen.getByLabelText("Error").textContent).not.toBe(""));
      const pending = JSON.parse(sessionStorage.getItem("akros-ontos-pending:default") ?? "null");
      expect(pending.sent).toBe(false);
      await user.click(screen.getByText("Edit order"));
      await user.click(screen.getByText("Submit"));
      await waitFor(() => expect(screen.getByLabelText("Submitted").textContent).toBe("true"));
      const placed = JSON.parse(requests[requests.length - 1]);
      expect(placed.clientRequestId).not.toBe(pending.clientRequestId);
      expect(placed.cart.lines[0].quantity).toBe(2);
      expect(quoteChecks).toBe(2);
      expect(requests).toHaveLength(rejection === "quote" ? 1 : 2);
    },
  );

  it("clears only the submitted cart after switching carts during an order request", async () => {
    const user = userEvent.setup();
    const cart = JSON.parse(localStorage.getItem("akros-demo-cart-v3") ?? "null");
    const collection = createCartCollection(cart);
    collection.carts[1].cart = { ...cart, lines: [{ ...cart.lines[0], quantity: 3 }] };
    localStorage.setItem(cartCollectionStorageKey, JSON.stringify({ version: 1, ...collection }));
    const pendingOrder = Promise.withResolvers<Response>();
    const fetchOrder = vi.fn<() => Promise<Response>>(() => pendingOrder.promise);
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

  it.each(["http", "json-shape", "invalid-json", "network", "network-remount"])(
    "replays the exact pending request after %s failure and a stock-only refresh",
    async (failure) => {
      const user = userEvent.setup();
      const requests: string[] = [];
      let quoteChecks = 0;
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
          if (url.endsWith("/cart")) {
            quoteChecks++;
            return Response.json({
              canCheckout: !attempted,
              priceChanged: false,
              issues: attempted ? ["Stock already debited"] : [],
            });
          }
          requests.push(options.body);
          if (!attempted) {
            attempted = true;
            if (failure.startsWith("network")) throw new TypeError("Failed to fetch");
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
      const view = render(
        <CartProvider>
          <CheckoutProvider>
            <Probe lineChange={{ stockCount: 99 }} />
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
      const pending = sessionStorage.getItem("akros-ontos-pending:default");
      expect(JSON.parse(pending ?? "null").body).toBe(requests[0]);
      await user.click(screen.getByText("Edit order"));
      expect(screen.getByLabelText("Stock").textContent).toBe("99");
      expect(sessionStorage.getItem("akros-ontos-pending:default")).toBe(pending);
      if (failure === "network-remount") {
        view.unmount();
        render(
          <CartProvider>
            <CheckoutProvider>
              <Probe />
            </CheckoutProvider>
          </CartProvider>,
        );
      }
      await waitFor(() => expect(screen.getByLabelText("Ready").textContent).toBe("true"));
      expect(screen.getByLabelText("Stock").textContent).toBe("99");
      await user.click(screen.getByText("Submit"));
      await waitFor(() => expect(screen.getByLabelText("Cart").textContent).toBe("0"));
      expect(screen.getByLabelText("Submitted").textContent).toBe("true");
      expect(quoteChecks).toBe(1);
      expect(requests).toHaveLength(2);
      expect(JSON.parse(requests[1]).clientRequestId).toBe(JSON.parse(requests[0]).clientRequestId);
      expect(requests[0]).toBe(requests[1]);
      expect(sessionStorage.getItem("akros-demo-order-v1")).toBeNull();
    },
  );
});
