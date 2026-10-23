import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { CheckoutProvider, useCheckout } from "@/features/checkout/checkout-provider";
import { cartCollectionStorageKey } from "@/features/cart/cart-collection";

const item = {
  productId: "fixture",
  slug: "fixture",
  name: "Fixture",
  sku: "F",
  imageSrc: "/bolt.png",
  imageAlt: "Fixture",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 20,
  priceMinor: 100,
};
function Probe() {
  const { cart, carts, activeCartId, selectCart, addCart, removeCart, dispatch } = useCart();
  const { draft, ready, updateDraft } = useCheckout();
  return (
    <>
      <output aria-label="Active">{activeCartId}</output>
      <output aria-label="Quantity">{cart.lines[0]?.quantity ?? 0}</output>
      <output aria-label="Email">{ready ? draft.email : "loading"}</output>
      <output aria-label="Cart count">{carts.length}</output>
      {carts.map((entry) => (
        <button key={entry.id} onClick={() => selectCart(entry.id)}>
          {entry.name}
        </button>
      ))}
      <button onClick={() => dispatch({ type: "add", item, quantity: 2 })}>Add item</button>
      <button onClick={() => addCart("Third")}>Create cart</button>
      <button onClick={() => removeCart(activeCartId)}>Delete active</button>
      <button onClick={() => updateDraft((value) => ({ ...value, email: "changed@example.com" }))}>
        Change email
      </button>
    </>
  );
}
const renderCarts = () =>
  render(
    <CartProvider>
      <CheckoutProvider>
        <Probe />
      </CheckoutProvider>
    </CartProvider>,
  );
afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(
    "akros-demo-cart-v3",
    JSON.stringify({ version: 3, lines: [{ ...item, quantity: 5 }] }),
  );
});

describe("named demo carts", () => {
  it("migrates the existing cart, isolates contents and restores the active cart after remount", async () => {
    const user = userEvent.setup();
    const view = renderCarts();
    await waitFor(() => expect(screen.getByLabelText("Quantity").textContent).toBe("5"));
    await user.click(screen.getByRole("button", { name: "Komisní košík" }));
    expect(screen.getByLabelText("Quantity").textContent).toBe("0");
    await user.click(screen.getByText("Add item"));
    await waitFor(() => expect(screen.getByLabelText("Quantity").textContent).toBe("2"));
    await user.click(screen.getByRole("button", { name: "Výchozí košík" }));
    expect(screen.getByLabelText("Quantity").textContent).toBe("5");
    await user.click(screen.getByRole("button", { name: "Komisní košík" }));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(cartCollectionStorageKey)!).activeCartId).toBe(
        "commission",
      ),
    );
    view.unmount();
    renderCarts();
    await waitFor(() => expect(screen.getByLabelText("Active").textContent).toBe("commission"));
    expect(screen.getByLabelText("Quantity").textContent).toBe("2");
  });

  it("creates an empty cart, restores a surviving cart when deleting and keeps the last cart", async () => {
    const user = userEvent.setup();
    renderCarts();
    await screen.findByText("Výchozí košík");
    await user.click(screen.getByText("Create cart"));
    expect(screen.getByLabelText("Quantity").textContent).toBe("0");
    expect(screen.getByLabelText("Cart count").textContent).toBe("3");
    await user.click(screen.getByText("Delete active"));
    expect(screen.getByLabelText("Quantity").textContent).toBe("5");
    await user.click(screen.getByText("Delete active"));
    expect(screen.getByLabelText("Active").textContent).toBe("commission");
    await user.click(screen.getByText("Delete active"));
    expect(screen.getByLabelText("Cart count").textContent).toBe("1");
  });

  it("keeps the checkout draft separate for each cart", async () => {
    const user = userEvent.setup();
    renderCarts();
    await waitFor(() => expect(screen.getByLabelText("Email").textContent).not.toBe("loading"));
    const original = screen.getByLabelText("Email").textContent;
    await user.click(screen.getByText("Change email"));
    await waitFor(() =>
      expect(screen.getByLabelText("Email").textContent).toBe("changed@example.com"),
    );
    await user.click(screen.getByRole("button", { name: "Komisní košík" }));
    await waitFor(() => expect(screen.getByLabelText("Email").textContent).toBe(original));
    await user.click(screen.getByRole("button", { name: "Výchozí košík" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Email").textContent).toBe("changed@example.com"),
    );
  });

  it("preserves the legacy contents when the collection is corrupt", async () => {
    localStorage.setItem(
      cartCollectionStorageKey,
      '{"version":1,"carts":[{"id":"same","name":"One"},{"id":"same","name":"Two"}]}',
    );
    renderCarts();
    await waitFor(() => expect(screen.getByLabelText("Quantity").textContent).toBe("5"));
    expect(screen.getByLabelText("Active").textContent).toBe("default");
  });
});
