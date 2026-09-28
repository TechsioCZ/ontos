import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AddToCartButton } from "@/features/cart/add-to-cart-button";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";
import type { CartItemSnapshot } from "@/mock-storefront/cart";

const item: CartItemSnapshot = {
  productId: "product-screw",
  slug: "screw",
  name: "Screw",
  sku: "SKU-1",
  imageSrc: "/screw.png",
  imageAlt: "Screw",
  unit: "ks",
  stockCount: 100,
  priceMinor: 1290,
};

function CartCount() {
  const { itemCount } = useCart();

  return <output aria-label="Počet položek v košíku">{itemCount}</output>;
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
    await user.click(screen.getByRole("button", { name: "Přidat do košíku: Screw" }));

    expect(screen.getByLabelText("Počet položek v košíku").textContent).toBe("2");
  });

  it("adds the requested minimum order quantity", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <CartCount />
        <AddToCartButton item={item} quantity={10} />
      </CartProvider>,
    );

    await user.click(screen.getByRole("button", { name: `${cs.actions.addToCart}: Screw` }));

    expect(screen.getByRole("status").textContent).toBe("10");
  });

  it("restores a persisted quantity only once in Strict Mode", async () => {
    const storage = window.localStorage;
    storage.clear();
    storage.setItem(
      "akros-demo-cart-v2",
      JSON.stringify({
        version: 2,
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
      expect(screen.getByLabelText("Počet položek v košíku").textContent).toBe("2");
    });
  });
});
