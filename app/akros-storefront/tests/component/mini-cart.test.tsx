import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CartProvider } from "@/features/cart/cart-provider";
import { MiniCart } from "@/features/cart/mini-cart";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const cartLine = {
  productId: "product-chain",
  variantId: "variant-a4",
  slug: "nerezovy-retez",
  name: "Nerezový řetěz",
  sku: "CHAIN-A4",
  imageSrc: "/akros/products/product-02.jpg",
  imageAlt: "Nerezový řetěz",
  unit: "m",
  minimumQuantity: 0.5,
  stockCount: 100,
  priceMinor: 1290,
  variantLabel: "A4 · 4 mm",
  quantity: 2,
};

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MiniCart", () => {
  it("shows live cart data and variant details in the popup", async () => {
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({ version: 3, lines: [cartLine] }),
    );
    const user = userEvent.setup();

    render(
      <CartProvider storage={window.localStorage}>
        <MiniCart />
      </CartProvider>,
    );

    const trigger = await screen.findByRole("button", { name: /Košík, 1 položka/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);

    expect(await screen.findByText("Nerezový řetěz")).not.toBeNull();
    expect(screen.getByText("A4 · 4 mm")).not.toBeNull();
    expect(screen.getByText("2 m")).not.toBeNull();
    expect(screen.getByRole("link", { name: /Nerezový řetěz/ }).getAttribute("href")).toBe(
      "/kosik",
    );

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByText("Nerezový řetěz")).toBeNull();
    });
  });

  it("provides a useful empty state", async () => {
    const user = userEvent.setup();

    render(
      <CartProvider storage={null}>
        <MiniCart />
      </CartProvider>,
    );

    const trigger = await screen.findByRole("button", { name: /Košík, 0 položek/ });
    await user.click(trigger);

    expect(await screen.findByText("Košík je zatím prázdný.")).not.toBeNull();
    expect(screen.getByText("Přejít do košíku")).not.toBeNull();
  });
});
