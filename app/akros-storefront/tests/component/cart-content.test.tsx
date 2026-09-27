import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { CartContent } from "@/features/cart/cart-content";
import { CartProvider } from "@/features/cart/cart-provider";

describe("CartContent", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("lets a shopper remove a persisted product from the cart", async () => {
    window.localStorage.setItem(
      "akros-demo-cart-v1",
      JSON.stringify({
        version: 1,
        lines: [{ productId: "product-screw", quantity: 2 }],
      }),
    );

    const user = userEvent.setup();

    render(
      <CartProvider storage={window.localStorage}>
        <CartContent />
      </CartProvider>,
    );

    expect(
      await screen.findByText("Vrut univerzální se zápustnou hlavou s křížovou drážkou"),
    ).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Odebrat Vrut univerzální" }));

    await waitFor(() => {
      expect(screen.getByText("Košík je zatím prázdný.")).not.toBeNull();
    });
  });
});
