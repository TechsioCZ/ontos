import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CartContent } from "@/features/cart/cart-content";
import { CartProvider } from "@/features/cart/cart-provider";
import { renderStorefront } from "../support/storefront";

describe("CartContent", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("lets a shopper remove a persisted product from the cart", async () => {
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({
        version: 3,
        lines: [
          {
            productId: "product-screw",
            slug: "test-product",
            name: "Test product",
            sku: "SKU-1",
            imageSrc: "/akros/products/product-02.jpg",
            imageAlt: "Test product",
            unit: "ks",
            minimumQuantity: 1,
            stockCount: 20,
            priceMinor: 100,
            quantity: 2,
          },
        ],
      }),
    );

    const user = userEvent.setup();

    const view = renderStorefront(
      <CartProvider storage={window.localStorage}>
        <CartContent />
      </CartProvider>,
    );

    expect(await screen.findByText("Test product")).not.toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Množství: Test product" })).toHaveProperty(
      "value",
      "2",
    );

    await user.click(screen.getByRole("button", { name: "Odebrat Test product" }));

    await waitFor(() => {
      expect(screen.getByText("Košík je zatím prázdný.")).not.toBeNull();
    });
    expect(JSON.parse(window.localStorage.getItem("akros-demo-cart-v3") ?? "null")).toEqual({
      version: 3,
      lines: [],
    });

    view.unmount();
    renderStorefront(
      <CartProvider storage={window.localStorage}>
        <CartContent />
      </CartProvider>,
    );

    expect(await screen.findByText("Košík je zatím prázdný.")).not.toBeNull();
    expect(screen.queryByText("Test product")).toBeNull();
  });
});
