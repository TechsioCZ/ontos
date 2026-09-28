import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import type { CatalogProductVariant } from "@/mock-storefront/types";

const variants: CatalogProductVariant[] = [
  {
    id: "hex-bolt-m2x5",
    label: "M 2 × 5",
    packageQuantity: 1000,
    priceMinor: 84,
    stockCount: 24_000,
  },
  {
    id: "hex-bolt-m4x16",
    label: "M 4 × 16",
    packageQuantity: 500,
    priceMinor: 194,
    stockCount: 8_500,
  },
];

function CartLines() {
  const { cart } = useCart();

  return <output aria-label="Řádky košíku">{JSON.stringify(cart.lines)}</output>;
}

describe("ProductPurchaseForm", () => {
  it("adds the selected product variant as its own cart line", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm productId="product-hex-bolt" variants={variants} />
        <CartLines />
      </CartProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Koupit M 4 × 16" }));

    expect(screen.getByLabelText("Řádky košíku").textContent).toBe(
      JSON.stringify([
        {
          productId: "product-hex-bolt",
          variantId: "hex-bolt-m4x16",
          quantity: 1,
        },
      ]),
    );
  });
});
