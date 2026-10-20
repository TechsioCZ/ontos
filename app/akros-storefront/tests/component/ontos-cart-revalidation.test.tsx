import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, it, expect, vi } from "vitest";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { CartRevalidation } from "@/ontos/cart-revalidation";
import type { CartState } from "@/mock-storefront/cart";
vi.mock("@/ontos/catalog-provider", () => ({ useDataSource: () => "ontos" }));
const cart: CartState = {
  version: 3,
  lines: [
    {
      productId: "p",
      variantId: "v",
      slug: "p",
      name: "Vruty",
      variantLabel: "3,5 × 16",
      sku: "S",
      imageSrc: "",
      imageAlt: "",
      unit: "ks",
      minimumQuantity: 200,
      quantityStep: 200,
      stockCount: 1000,
      priceMinor: 121,
      quantity: 200,
    },
  ],
};
function Harness() {
  const { cart: current, dispatch } = useCart();
  return (
    <>
      <button onClick={() => dispatch({ type: "revalidate", cart })}>Načíst</button>
      <output aria-label="Ceny">{JSON.stringify(current)}</output>
      <CartRevalidation />
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("discloses old/new unit, line and cart totals BEFORE acceptance and changes nothing until clicked", async () => {
  const quoted = { ...cart, lines: [{ ...cart.lines[0], priceMinor: 122 }] };
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ cart: quoted, priceChanged: true, issues: [], canCheckout: false }),
      }),
  );
  const user = userEvent.setup();
  render(
    <CartProvider storage={null}>
      <Harness />
    </CartProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Načíst" }));
  await screen.findByRole("button", { name: "Přijmout nové ceny" });
  expect(screen.getByText(/Za ks:/).textContent).toMatch(/1,21.*→.*1,22/);
  expect(screen.getByText(/Za 200 ks:/).textContent).toMatch(/242.*→.*244/);
  expect(screen.getByText(/Celkem za zboží:/).textContent).toMatch(/242.*→.*244/);
  expect(JSON.parse(screen.getByLabelText("Ceny").textContent!).lines[0].priceMinor).toBe(121);
  await user.click(screen.getByRole("button", { name: "Přijmout nové ceny" }));
  await waitFor(() =>
    expect(JSON.parse(screen.getByLabelText("Ceny").textContent!).lines[0].priceMinor).toBe(122),
  );
});
