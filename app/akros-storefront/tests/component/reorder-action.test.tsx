import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReorderAction } from "@/features/account/reorder-action";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import type { CartItemSnapshot } from "@/features/cart/cart-state";

const item: CartItemSnapshot = {
  productId: "product",
  variantId: "variant",
  slug: "bolt",
  name: "Bolt",
  variantLabel: "M8",
  sku: "SKU-8",
  imageSrc: "/bolt.png",
  imageAlt: "Bolt",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 100,
  priceMinor: 121,
};
function State() {
  const { cart, addCart } = useCart();
  return (
    <>
      <output aria-label="Cart state">{JSON.stringify(cart.lines)}</output>
      <button onClick={() => addCart("Other")}>Switch cart</button>
    </>
  );
}
function renderReorder() {
  render(
    <CartProvider storage={null}>
      <ReorderAction orderId="native-order" />
      <State />
    </CartProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("native reorder UI", () => {
  it("awaits the existing cart owner check before showing success", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        calls.push(String(url));
        if (String(url).includes("/reorder?"))
          return Response.json({
            items: [{ item, quantity: 4, priceTiers: [] }],
            skipped: 1,
            adjusted: 0,
          });
        return Response.json({
          ...JSON.parse(String(init?.body)),
          priceChanged: false,
          canCheckout: true,
          issues: [],
        });
      }),
    );
    renderReorder();
    await userEvent.setup().click(screen.getByRole("button", { name: "Objednat znovu" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Cart state").textContent).toContain('"quantity":4'),
    );
    expect(calls).toEqual(["/api/ontos/orders/reorder?order=native-order", "/api/ontos/cart"]);
    expect(screen.getByText(/Přidáno položek: 1\. Nepřidáno: 1\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Přejít do košíku" }).getAttribute("href")).toBe(
      "/kosik",
    );
  });
  it("does not report success or change the cart when the current price is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) =>
        String(url).includes("/reorder?")
          ? Response.json({
              items: [
                { item, quantity: 4, priceTiers: [] },
                { item, quantity: 2, priceTiers: [] },
              ],
              skipped: 0,
              adjusted: 0,
            })
          : Response.json({
              cart: { version: 3, lines: [] },
              priceChanged: true,
              canCheckout: false,
            }),
      ),
    );
    renderReorder();
    await userEvent.setup().click(screen.getByRole("button", { name: "Objednat znovu" }));
    await waitFor(() =>
      expect(screen.getByText(/Přidáno položek: 0\. Nepřidáno: 2\./)).toBeTruthy(),
    );
    expect(screen.getByLabelText("Cart state").textContent).toBe("[]");
    expect(screen.queryByRole("link", { name: "Přejít do košíku" })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not apply prepared items to a cart selected while the order was loading", async () => {
    let respond!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      ),
    );
    renderReorder();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Objednat znovu" }));
    await user.click(screen.getByRole("button", { name: "Switch cart" }));
    await act(async () =>
      respond(
        Response.json({ items: [{ item, quantity: 4, priceTiers: [] }], skipped: 0, adjusted: 0 }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByText(/Přidáno položek: 0\. Nepřidáno: 1\./)).toBeTruthy(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Cart state").textContent).toBe("[]");
  });
  it("shows the actual preparation error without changing the cart", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ message: "Přihlaste se ke svému účtu." }, { status: 401 }),
      ),
    );
    renderReorder();
    await userEvent.setup().click(screen.getByRole("button", { name: "Objednat znovu" }));
    await waitFor(() => expect(screen.getByText("Přihlaste se ke svému účtu.")).toBeTruthy());
    expect(screen.getByLabelText("Cart state").textContent).toBe("[]");
  });
});
