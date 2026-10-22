import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutProvider, useCheckout } from "@/features/checkout/checkout-provider";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { createCheckoutDraft } from "@/mock-storefront/checkout";
import { OrderConfirmation } from "@/features/checkout/order-confirmation";
import { checkoutSaveError } from "@/ontos/checkout-response";

function Probe() {
  const { draft, updateDraft, completeOrder, ready, storageError } = useCheckout();
  const { cart } = useCart();
  return (
    <>
      <output aria-label="Kontakt">{ready ? draft.email : "loading"}</output>
      <output aria-label="Košík">{cart.lines.length}</output>
      <output aria-label="Chyba">{storageError}</output>
      <button onClick={() => updateDraft((value) => ({ ...value, email: "new@example.cz" }))}>
        Upravit
      </button>
      <button onClick={() => completeOrder()}>Objednat</button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem(
    "akros-demo-cart-v3",
    JSON.stringify({
      version: 3,
      lines: [
        {
          productId: "chain",
          slug: "chain",
          name: "Řetěz",
          sku: "A4",
          imageSrc: "/chain.jpg",
          imageAlt: "Řetěz",
          unit: "m",
          minimumQuantity: 0.5,
          stockCount: 10,
          priceMinor: 121,
          priceExcludingVatMinor: 100,
          quantity: 0.5,
        },
      ],
    }),
  );
});

describe("checkout persistence", () => {
  it("restores and saves incomplete personal details within the session", async () => {
    const user = userEvent.setup();
    const draft = { ...createCheckoutDraft(), email: "restored@example.cz" };
    window.sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify({ version: 1, draft }));
    const view = render(
      <CartProvider>
        <CheckoutProvider>
          <Probe />
        </CheckoutProvider>
      </CartProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Kontakt").textContent).toBe("restored@example.cz"),
    );
    await user.click(screen.getByText("Upravit"));
    view.unmount();
    render(
      <CartProvider>
        <CheckoutProvider>
          <Probe />
        </CheckoutProvider>
      </CartProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Kontakt").textContent).toBe("new@example.cz"),
    );
  });

  it("saves the OntOS order before clearing the cart and does not submit twice", async () => {
    const user = userEvent.setup();
    const orderRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (url === "/api/ontos/cart")
          return Response.json({ canCheckout: true, priceChanged: false, issues: [] });
        if (url === "/api/ontos/orders") {
          orderRequests.push(String(options.body));
          return Response.json({
            outcome: "PLACED",
            orderNumber: "OBJ-2026-0100",
            totalMinor: 7961,
            totalVatMinor: 1382,
          });
        }
        return Response.json({}, { status: 404 });
      }),
    );
    const draft = {
      ...createCheckoutDraft(),
      deliveryId: "zasilkovna",
      pickupPointId: "zasilkovna-praha",
    };
    window.sessionStorage.setItem("akros-demo-checkout-v1", JSON.stringify({ version: 1, draft }));
    const view = render(
      <CartProvider>
        <CheckoutProvider>
          <Probe />
        </CheckoutProvider>
      </CartProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Košík").textContent).toBe("1"));
    await user.dblClick(screen.getByText("Objednat"));
    await waitFor(() => expect(screen.getByLabelText("Košík").textContent).toBe("0"));
    expect(orderRequests).toHaveLength(1);
    const order = JSON.parse(window.sessionStorage.getItem("akros-demo-order-v1") ?? "null");
    expect(order.cart.lines[0]).toMatchObject({ quantity: 0.5, priceExcludingVatMinor: 100 });
    expect(order.draft.email).toBe(draft.email);
    expect(order.id).toBe("OBJ-2026-0100");
    expect(order.totals).toMatchObject({ total: 7961, vat: 1382, net: 6579 });
    expect(order.paymentStatus).toBe("not-processed");
    view.unmount();
    const confirmation = render(<OrderConfirmation />);
    expect(await screen.findByText(order.id)).not.toBeNull();
    expect(screen.getByText("79,61 Kč", { exact: false })).not.toBeNull();
    expect(screen.getByText("Neprovedena (demo)")).not.toBeNull();
    confirmation.unmount();
    render(<OrderConfirmation />);
    expect(await screen.findByText(order.id)).not.toBeNull();
  });

  it("keeps cart contents when browser storage fails before submission", async () => {
    const user = userEvent.setup();
    const storage = {
      getItem: () =>
        JSON.stringify({
          version: 1,
          draft: { ...createCheckoutDraft(), deliveryId: "osobni" },
        }),
      setItem: () => {
        throw new Error("Quota exceeded");
      },
    };
    render(
      <CartProvider>
        <CheckoutProvider storage={storage}>
          <Probe />
        </CheckoutProvider>
      </CartProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Košík").textContent).toBe("1"));
    await user.click(screen.getByText("Objednat"));
    expect(screen.getByLabelText("Košík").textContent).toBe("1");
    expect(screen.getByLabelText("Chyba").textContent).toBe(checkoutSaveError);
  });

  it.each([null, "broken", JSON.stringify({ version: 1, paymentStatus: "paid" })])(
    "does not invent a confirmation for missing or invalid stored orders: %s",
    async (saved) => {
      if (saved) window.sessionStorage.setItem("akros-demo-order-v1", saved);
      render(<OrderConfirmation />);
      expect(await screen.findByText("Není zde dokončená objednávka")).not.toBeNull();
      expect(screen.queryByText(/DEMO objednávka č\./)).toBeNull();
    },
  );
});
