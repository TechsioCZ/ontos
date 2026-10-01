import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CartContent } from "@/features/cart/cart-content";
import { CartProvider } from "@/features/cart/cart-provider";
import { CheckoutLayout } from "@/features/checkout/checkout-layout";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";

vi.mock("next/navigation", () => ({
  usePathname: () => "/kosik",
  useRouter: () => ({
    push: vi.fn<(href: string) => void>(),
    replace: vi.fn<(href: string) => void>(),
  }),
}));

afterEach(cleanup);
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function renderCart() {
  return render(
    <CartProvider>
      <CheckoutProvider>
        <CheckoutLayout recommendations={[]}>
          <CartContent />
        </CheckoutLayout>
      </CheckoutProvider>
    </CartProvider>,
  );
}

describe("checkout cart composition", () => {
  it("places a single summary between cart items and the continue action", async () => {
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({
        version: 3,
        lines: [
          {
            productId: "screw",
            slug: "screw",
            name: "Vrut",
            sku: "A2",
            imageSrc: "/screw.jpg",
            imageAlt: "Vrut",
            unit: "ks",
            minimumQuantity: 1,
            stockCount: 100,
            priceMinor: 100,
            quantity: 30,
          },
        ],
      }),
    );
    renderCart();
    const items = await screen.findByRole("region", { name: "Obsah košíku" });
    const summary = screen.getByRole("complementary", { name: "Shrnutí" });
    const next = screen.getByRole("link", { name: "Vybrat dopravu a platbu" });
    expect(screen.getAllByRole("complementary", { name: "Shrnutí" })).toHaveLength(1);
    expect(items.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(summary.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(next.getAttribute("href")).toBe("/kosik/doprava-platba");
  });

  it("hides the summary and checkout action when the cart is empty", async () => {
    renderCart();
    expect(await screen.findByText("Košík je zatím prázdný.")).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "Shrnutí" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Vybrat dopravu a platbu" })).toBeNull();
    expect(screen.getByRole("link", { name: "Zpět do katalogu" })).not.toBeNull();
  });
});
