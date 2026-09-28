import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import type { CatalogProduct, CatalogProductVariant } from "@/mock-storefront/types";

const variants: CatalogProductVariant[] = [
  {
    id: "item-1",
    sourceId: "1",
    sku: "10093300020005",
    label: "M 2 × 5",
    minimumQuantity: 10,
    priceMinor: 84,
    stockCount: 24_000,
    unit: "ks",
    priceTiers: [],
    parameters: [],
  },
  {
    id: "item-2",
    sourceId: "2",
    sku: "10093300040016",
    label: "M 4 × 16",
    minimumQuantity: 10,
    priceMinor: 194,
    stockCount: 8_500,
    unit: "ks",
    priceTiers: [],
    parameters: [],
  },
];

const product: CatalogProduct = {
  id: "product-hex-bolt",
  slug: "hex-bolt",
  categoryId: "bolts",
  name: "DIN 933/A2",
  sku: "10093300",
  description: "",
  priceMinor: 84,
  currency: "CZK",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 32_500,
  imageSrc: "/bolt.png",
  imageAlt: "Bolt",
  featuredPosition: null,
  detail: { descriptionParagraphs: [], parameters: [], priceTiers: [], variants },
};

function CartLines() {
  const { cart } = useCart();
  return <output aria-label="Řádky košíku">{JSON.stringify(cart.lines)}</output>;
}

afterEach(cleanup);

describe("ProductPurchaseForm", () => {
  it("adds the selected source variant with its minimum order quantity", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={variants} />
        <CartLines />
      </CartProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Koupit M 4 × 16" }));

    expect(JSON.parse(screen.getByLabelText("Řádky košíku").textContent ?? "[]")).toEqual([
      expect.objectContaining({
        productId: "product-hex-bolt",
        variantId: "item-2",
        sku: "10093300040016",
        priceMinor: 194,
        quantity: 10,
      }),
    ]);
  });

  it("does not allow buying an out-of-stock source variant", () => {
    render(
      <CartProvider storage={null}>
        <ProductPurchaseForm product={product} variants={[{ ...variants[0], stockCount: 0 }]} />
      </CartProvider>,
    );

    expect(screen.getByRole("button", { name: "Koupit M 2 × 5" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});
