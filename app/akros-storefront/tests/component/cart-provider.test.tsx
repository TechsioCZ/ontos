import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderStorefront as render } from "../support/storefront";
import { browserAt, serveHttp } from "../support/http";

import { AddToCartButton } from "@/features/cart/add-to-cart-button";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";
import type { CartItemSnapshot } from "@/features/cart/cart-state";

const item: CartItemSnapshot = {
  productId: "product-screw",
  slug: "screw",
  name: "Screw",
  sku: "SKU-1",
  imageSrc: "/screw.png",
  imageAlt: "Screw",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 100,
  priceMinor: 1290,
};

function CartCount() {
  const { itemCount } = useCart();

  return <output aria-label="Počet položek v košíku">{itemCount}</output>;
}

function CartQuantity() {
  const { cart } = useCart();

  return <output aria-label="Množství první položky">{cart.lines[0]?.quantity ?? 0}</output>;
}

afterEach(cleanup);

describe("CartProvider", () => {
  it("updates the announced cart count without navigating away", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <CartCount />
        <AddToCartButton item={item} />
      </CartProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Přidat do košíku: Screw" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Počet položek v košíku").textContent).toBe("1"),
    );
    await user.click(screen.getByRole("button", { name: "Přidat do košíku: Screw" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Počet položek v košíku").textContent).toBe("1"),
    );
  });

  it("adds the requested minimum order quantity", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <CartQuantity />
        <AddToCartButton item={item} quantity={10} />
      </CartProvider>,
    );

    await user.click(screen.getByRole("button", { name: `${cs.actions.addToCart}: Screw` }));

    await waitFor(() =>
      expect(screen.getByLabelText("Množství první položky").textContent).toBe("10"),
    );
  });

  it("restores a persisted quantity only once in Strict Mode", async () => {
    const storage = window.localStorage;
    storage.clear();
    storage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({
        version: 3,
        lines: [{ ...item, quantity: 2 }],
      }),
    );

    render(
      <StrictMode>
        <CartProvider storage={storage}>
          <CartCount />
        </CartProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Počet položek v košíku").textContent).toBe("1");
    });
  });

  it("restores a persisted decimal quantity", async () => {
    const storage = window.localStorage;
    storage.clear();
    storage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({
        version: 3,
        lines: [
          {
            ...item,
            unit: "m",
            minimumQuantity: 0.5,
            stockCount: 3.5,
            quantity: 0.5,
          },
        ],
      }),
    );

    render(
      <CartProvider storage={storage}>
        <CartQuantity />
      </CartProvider>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Množství první položky").textContent).toBe("0.5");
    });
  });
});

// Every add crosses a real loopback HTTP exchange before the provider changes its state.
let network: Awaited<ReturnType<typeof serveHttp>>;
beforeEach(async () => {
  network = await serveHttp(async (request) => {
    if (new URL(request.url).pathname !== "/api/ontos/cart" || request.method !== "POST")
      return new Response("Unknown endpoint", { status: 404 });
    const { cart } = await request.json();
    const blocked = cart.lines.some(
      (line: { quantity: number; stockCount: number }) => line.quantity > line.stockCount,
    );
    return Response.json({
      cart,
      priceChanged: false,
      issues: blocked ? ["OntOS: požadované množství není skladem."] : [],
      canCheckout: !blocked,
    });
  });
  browserAt(network.origin);
});
afterEach(async () => {
  await network.idle();
  await network.close();
});
