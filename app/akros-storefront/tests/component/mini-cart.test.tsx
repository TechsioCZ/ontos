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

    const trigger = await screen.findByRole("link", { name: /Košík, 1 položka/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("href")).toBe("/kosik");

    await user.hover(trigger);

    expect(await screen.findByText("Nerezový řetěz")).not.toBeNull();
    expect(screen.getByText("A4 · 4 mm")).not.toBeNull();
    expect(screen.getByText("2 m")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
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

    const trigger = await screen.findByRole("link", { name: /Košík, 0 položek/ });
    await user.hover(trigger);

    expect(await screen.findByText("Košík je zatím prázdný.")).not.toBeNull();
    expect(screen.getByText("Přejít do košíku")).not.toBeNull();
  });

  it("keeps the preview open when moving into it and closes after leaving", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <MiniCart />
      </CartProvider>,
    );

    const trigger = await screen.findByRole("link", { name: /Košík, 0 položek/ });
    await user.hover(trigger);
    const preview = await screen.findByRole("dialog");
    await user.hover(preview);
    // Crossing into the portalled panel must cancel the trigger's pending close.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await user.unhover(preview);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("supports keyboard preview, escape, and tabbing away", async () => {
    const user = userEvent.setup();
    render(
      <CartProvider storage={null}>
        <MiniCart />
        <button type="button">Outside</button>
      </CartProvider>,
    );

    const trigger = await screen.findByRole("link", { name: /Košík, 0 položek/ });
    await user.tab();
    expect(document.activeElement).toBe(trigger);
    expect(await screen.findByRole("dialog")).not.toBeNull();
    await user.tab();
    expect(document.activeElement?.textContent).toContain("Přejít do košíku");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
