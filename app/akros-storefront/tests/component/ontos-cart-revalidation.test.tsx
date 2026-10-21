import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, it, expect, vi } from "vitest";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { CartQuoteProvider, CartRevalidation } from "@/ontos/cart-revalidation";
import { CartNavigation } from "@/features/cart/cart-content";
import { CartItemsTable } from "@/features/checkout/cart-items-table";
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
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cart: quoted, priceChanged: true, issues: [], canCheckout: false }),
    }),
  );
  const user = userEvent.setup();
  render(
    <CartProvider storage={null}>
      <CartQuoteProvider>
        <Harness />
      </CartQuoteProvider>
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

it("shows an explicit error with 'Zkusit znovu' and keeps the continue action disabled until a quote succeeds", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      json: async () => ({ message: "Spojení s OntOS se nepodařilo." }),
    })
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        cart,
        priceChanged: false,
        issues: [],
        lineIssues: [],
        canCheckout: true,
        totals: { totalMinor: 24200, totalVatMinor: 4200, netMinor: 20000, shippingMinor: null },
      }),
    });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(
    <CartProvider storage={null}>
      <CartQuoteProvider>
        <Harness />
        <CartNavigation />
      </CartQuoteProvider>
    </CartProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Načíst" }));
  await screen.findByText(/Ceny a dostupnost se teď nepodařilo ověřit/);
  expect(screen.getByText("Demonstrační košík – nejde o skutečný nákup")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Vybrat dopravu a platbu" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Zkusit znovu" }));
  await screen.findByText("Ceny, množství a dostupnost byly ověřeny v OntOS.");
  expect(screen.getByRole("link", { name: "Vybrat dopravu a platbu" })).toBeTruthy();
});

it("marks a blocked line with its unavailable state and names the variant", async () => {
  const message =
    "Vruty (3,5 × 16): dostupnost nyní nelze ověřit, objednávku proto nelze dokončit.";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        cart,
        priceChanged: false,
        issues: [message],
        lineIssues: [{ productId: "p", variantId: "v", code: "AVAILABILITY_UNKNOWN", message }],
        canCheckout: false,
        totals: null,
      }),
    }),
  );
  const user = userEvent.setup();
  render(
    <CartProvider storage={null}>
      <CartQuoteProvider>
        <Harness />
        <CartItemsTable />
        <CartNavigation />
      </CartQuoteProvider>
    </CartProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Načíst" }));
  await screen.findByText("Objednávku teď nelze dokončit");
  expect(screen.getByText("Nelze ověřit")).toBeTruthy();
  expect(screen.queryByText("Skladem")).toBeNull();
  expect(screen.getAllByText(message).length).toBeGreaterThan(0);
  expect(
    (screen.getByRole("button", { name: "Vybrat dopravu a platbu" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
