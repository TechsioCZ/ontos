import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { AddToCartButton } from "@/features/cart/add-to-cart-button";
import { CartProvider, useCart } from "@/features/cart/cart-provider";

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
        <AddToCartButton productId="product-screw" />
      </CartProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Přidat do košíku" }));
    await user.click(screen.getByRole("button", { name: "Přidat do košíku" }));

    expect(screen.getByLabelText("Počet položek v košíku").textContent).toBe("2");
  });

  it("restores a persisted quantity only once in Strict Mode", async () => {
    const storage = window.localStorage;
    storage.clear();
    storage.setItem(
      "akros-demo-cart-v1",
      JSON.stringify({
        version: 1,
        lines: [{ productId: "product-screw", quantity: 2 }],
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
