import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toaster } from "@techsio/ui-kit/molecules/toast";
import { AddToCartButton } from "@/features/cart/add-to-cart-button";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { CartNotifications } from "@/features/cart/cart-notifications";
import { CartItemsTable } from "@/features/checkout/cart-items-table";
import type { CartItemSnapshot } from "@/mock-storefront/cart";

const item: CartItemSnapshot = {
  productId: "rod",
  variantId: "rod-a2",
  slug: "rod",
  name: "Tyč",
  sku: "ROD-A2",
  imageSrc: "/rod.jpg",
  imageAlt: "Tyč",
  unit: "m",
  minimumQuantity: 0.5,
  stockCount: 3.5,
  priceMinor: 1000,
  variantLabel: "Tyč 6 mm / A2",
};

function CartProbe() {
  const { cart, dispatch } = useCart();
  return (
    <>
      <output aria-label="Stav košíku">{JSON.stringify(cart.lines)}</output>
      <button type="button" onClick={() => dispatch({ type: "clear" })}>
        Vyprázdnit košík
      </button>
    </>
  );
}

function renderCart(quantity = 0.5, product = item) {
  return render(
    <StrictMode>
      <CartProvider>
        <AddToCartButton item={product} quantity={quantity} />
        <CartItemsTable />
        <CartProbe />
        <CartNotifications />
      </CartProvider>
    </StrictMode>,
  );
}

function lines() {
  return JSON.parse(screen.getByLabelText("Stav košíku").textContent ?? "[]");
}

beforeEach(() => {
  window.localStorage.clear();
  toaster.remove();
});
afterEach(() => {
  cleanup();
  toaster.remove();
});

describe("cart action notifications", () => {
  it("confirms the precise variant and quantity without taking focus or stacking repeated additions", async () => {
    const user = userEvent.setup();
    renderCart();
    const add = screen.getByRole("button", { name: "Přidat do košíku: Tyč 6 mm / A2" });
    await user.click(add);
    expect(await screen.findByText("Přidáno do košíku")).not.toBeNull();
    const notification = screen.getByText("Přidáno do košíku").closest('[role="status"]');
    if (!(notification instanceof HTMLElement)) throw new Error("Missing notification");
    expect(within(notification).getByText(/0,5 m/)).not.toBeNull();
    expect(within(notification).getByText(/Tyč 6 mm \/ A2/)).not.toBeNull();
    expect(
      within(notification).getByRole("link", { name: "Zobrazit košík" }).getAttribute("href"),
    ).toBe("/kosik");
    expect(document.activeElement).toBe(add);
    await user.click(add);
    expect(lines()[0].quantity).toBe(1);
    expect(screen.getAllByText("Přidáno do košíku")).toHaveLength(1);
  });

  it("reports only the quantity that fits and reports the stock limit instead of false success", async () => {
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({ version: 3, lines: [{ ...item, quantity: 3 }] }),
    );
    const user = userEvent.setup();
    renderCart(1);
    await screen.findByDisplayValue("3");
    const add = screen.getByRole("button", { name: "Přidat do košíku: Tyč 6 mm / A2" });
    await user.click(add);
    expect(await screen.findByText(/Přidáno 0,5 m/)).not.toBeNull();
    expect(screen.getByText(/část požadovaného množství/)).not.toBeNull();
    expect(lines()[0].quantity).toBe(3.5);
    await user.click(add);
    expect(await screen.findByText("Nelze přidat další množství")).not.toBeNull();
    expect(screen.queryByText("Přidáno do košíku")).toBeNull();
    expect(lines()[0].quantity).toBe(3.5);
  });

  it("does not announce restored storage as a new addition", async () => {
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({ version: 3, lines: [{ ...item, quantity: 2 }] }),
    );
    renderCart();
    await screen.findByDisplayValue("2");
    expect(screen.queryByText("Přidáno do košíku")).toBeNull();
  });

  it("does not confuse decimal arithmetic with a stock limit", async () => {
    const fractional = { ...item, minimumQuantity: 0.1 };
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({
        version: 3,
        lines: [{ ...fractional, quantity: 0.1 }],
      }),
    );
    const user = userEvent.setup();
    renderCart(0.2, fractional);
    await screen.findByDisplayValue("0,1");
    await user.click(screen.getByRole("button", { name: "Přidat do košíku: Tyč 6 mm / A2" }));
    expect(await screen.findByText("Přidáno 0,2 m.")).not.toBeNull();
    expect(screen.queryByText(/část požadovaného množství/)).toBeNull();
  });

  it("undoes removal with the original variant, quantity, and position without reverting other lines", async () => {
    const other = {
      ...item,
      variantId: "rod-a4",
      sku: "ROD-A4",
      variantLabel: "Tyč 8 mm / A4",
      quantity: 1,
    };
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({ version: 3, lines: [{ ...item, quantity: 2.5 }, other] }),
    );
    const user = userEvent.setup();
    renderCart();
    await screen.findByDisplayValue("2,5");
    await user.click(screen.getAllByRole("button", { name: "Odebrat Tyč" })[0]);
    expect(await screen.findByText("Položka odebrána")).not.toBeNull();
    expect(lines()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Zvýšit množství: Tyč 8 mm / A4" }));
    await user.click(screen.getByRole("button", { name: "Obnovit" }));
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(
      lines().map((line: { variantId: string; quantity: number }) => [
        line.variantId,
        line.quantity,
      ]),
    ).toEqual([
      ["rod-a2", 2.5],
      ["rod-a4", 1.5],
    ]);
    expect(screen.queryByRole("button", { name: "Obnovit" })).toBeNull();
    expect(await screen.findByText("Položka obnovena")).not.toBeNull();
  });

  it("merges undo into a re-added variant without overwriting the new quantity", async () => {
    const user = userEvent.setup();
    renderCart();
    const add = screen.getByRole("button", { name: "Přidat do košíku: Tyč 6 mm / A2" });
    await user.click(add);
    await user.click(screen.getByRole("button", { name: "Odebrat Tyč" }));
    await user.click(add);
    await user.click(screen.getByRole("button", { name: "Obnovit" }));
    await waitFor(() => expect(lines()[0].quantity).toBe(1));
    expect(lines()).toHaveLength(1);
  });

  it("clears pending undo when the cart is cleared", async () => {
    const user = userEvent.setup();
    renderCart();
    await user.click(screen.getByRole("button", { name: "Přidat do košíku: Tyč 6 mm / A2" }));
    await user.click(screen.getByRole("button", { name: "Odebrat Tyč" }));
    expect(await screen.findByRole("button", { name: "Obnovit" })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Vyprázdnit košík" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Obnovit" })).toBeNull());
    expect(lines()).toHaveLength(0);
  });

  it("forgets undo after the notification is explicitly closed", async () => {
    const user = userEvent.setup();
    renderCart();
    await user.click(screen.getByRole("button", { name: "Přidat do košíku: Tyč 6 mm / A2" }));
    await user.click(screen.getByRole("button", { name: "Odebrat Tyč" }));
    await screen.findByRole("button", { name: "Obnovit" });
    await user.click(screen.getByRole("button", { name: "Close notification" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Obnovit" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Přidat do košíku: Tyč 6 mm / A2" }));
    expect(lines()[0].quantity).toBe(0.5);
    expect(screen.queryByRole("button", { name: "Obnovit" })).toBeNull();
  });

  it("restores only the most recently removed item", async () => {
    const other = { ...item, variantId: "rod-a4", sku: "ROD-A4", quantity: 1 };
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({
        version: 3,
        lines: [{ ...item, quantity: 2 }, other],
      }),
    );
    const user = userEvent.setup();
    renderCart();
    await screen.findByDisplayValue("2");
    await user.click(screen.getAllByRole("button", { name: "Odebrat Tyč" })[0]);
    await screen.findByRole("button", { name: "Obnovit" });
    await user.click(screen.getByRole("button", { name: "Odebrat Tyč" }));
    expect(screen.getAllByRole("button", { name: "Obnovit" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Obnovit" }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0].variantId).toBe("rod-a4");
    expect(lines()[0].quantity).toBe(1);
  });

  it("respects stock when undoing a removal after re-adding the variant", async () => {
    window.localStorage.setItem(
      "akros-demo-cart-v3",
      JSON.stringify({
        version: 3,
        lines: [{ ...item, quantity: 3 }],
      }),
    );
    const user = userEvent.setup();
    renderCart(1);
    await screen.findByDisplayValue("3");
    await user.click(screen.getByRole("button", { name: "Odebrat Tyč" }));
    await user.click(screen.getByRole("button", { name: "Přidat do košíku: Tyč 6 mm / A2" }));
    await user.click(screen.getByRole("button", { name: "Obnovit" }));
    await waitFor(() => expect(lines()[0].quantity).toBe(3.5));
    expect(await screen.findByText("Obnoveno 2,5 m.")).not.toBeNull();
    expect(screen.getByText(/část požadovaného množství/)).not.toBeNull();
  });
});
