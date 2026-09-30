import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import NewsPage from "@/app/novinky-a-akce/page";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { getPromotionItems } from "@/mock-storefront/catalog";

vi.mock("@/components/storefront-shell", () => ({
  StorefrontWideShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

function CartLines() {
  const { cart } = useCart();
  return <output aria-label="Řádky košíku">{JSON.stringify(cart.lines)}</output>;
}

afterEach(cleanup);

describe("NewsPage shared product cards", () => {
  it("uses the catalog cards in both sections without invented discount percentages", () => {
    const { container } = render(
      <CartProvider storage={null}>
        <NewsPage />
      </CartProvider>,
    );

    expect(container.querySelectorAll(".akros-catalog-product-card")).toHaveLength(8);
    expect(container.querySelector(".akros-news-product-card")).toBeNull();
    expect(container.querySelector("del")).toBeNull();
    expect(screen.queryByText(/^-\d+%$/)).toBeNull();
    expect(screen.getAllByRole("link", { name: "Zobrazit oblíbené produkty" })).toHaveLength(8);
    expect(screen.getByText("Doprodej")).toBeDefined();
  });

  it("links the clearance card to its exact variant and uses its price rather than the group minimum", () => {
    const { product, variant } = getPromotionItems().find((item) => item.kind === "sale")!;

    render(
      <CartProvider storage={null}>
        <NewsPage />
      </CartProvider>,
    );

    expect(screen.getByText("83,32 Kč")).toBeDefined();
    for (const link of screen.getAllByRole("link", { name: variant!.label })) {
      expect(link.getAttribute("href")).toBe(
        `/produkt/${product.slug}?variant=${encodeURIComponent(variant!.sku)}`,
      );
    }
    expect(screen.getByText("Doprodej").getAttribute("title")).toBeNull();
  });

  it("adds the exact promoted variant with the source price and minimum order quantity", async () => {
    const user = userEvent.setup();
    const { product, variant } = getPromotionItems().find((item) => item.kind === "sale")!;

    render(
      <CartProvider storage={null}>
        <NewsPage />
        <CartLines />
      </CartProvider>,
    );
    await user.click(screen.getByRole("button", { name: `Přidat do košíku: ${variant!.label}` }));

    expect(JSON.parse(screen.getByLabelText("Řádky košíku").textContent!)).toMatchObject([
      {
        productId: product.id,
        variantId: variant!.id,
        name: product.name,
        sku: variant!.sku,
        priceMinor: variant!.priceMinor,
        quantity: variant!.minimumQuantity,
      },
    ]);
  });
});
