import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, it, expect } from "vitest";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { CartQuoteProvider, CartRevalidation } from "@/ontos/cart-revalidation";
import { CartNavigation } from "@/features/cart/cart-content";
import { CartItemsTable } from "@/features/checkout/cart-items-table";
import type { CartState } from "@/features/cart/cart-state";
import { browserAt, serveHttp } from "../support/http";
import { renderStorefront as render } from "../support/storefront";
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
let network: Awaited<ReturnType<typeof serveHttp>> | undefined;
afterEach(async () => {
  cleanup();
  if (network) {
    await network.idle();
    await network.close();
    network = undefined;
  }
});
it("discloses old/new unit, line and cart totals BEFORE acceptance and changes nothing until clicked", async () => {
  const quoted = { ...cart, lines: [{ ...cart.lines[0], priceMinor: 122 }] };
  network = await serveHttp((request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/ontos/cart")
      return new Response("Unknown endpoint", { status: 404 });
    return Response.json({ cart: quoted, priceChanged: true, issues: [], canCheckout: false });
  });
  browserAt(network.origin);
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
  await network.idle();
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
  let attempts = 0;
  network = await serveHttp((request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/ontos/cart")
      return new Response("Unknown endpoint", { status: 404 });
    attempts += 1;
    if (attempts === 1)
      return Response.json({ message: "Spojení s OntOS se nepodařilo." }, { status: 503 });
    return Response.json({
      cart,
      priceChanged: false,
      issues: [],
      lineIssues: [],
      canCheckout: true,
      totals: { totalMinor: 24200, totalVatMinor: 4200, netMinor: 20000, shippingMinor: null },
    });
  });
  browserAt(network.origin);
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
  expect(screen.getByText("Aktuální ceny a dostupnost z OntOS")).toBeTruthy();
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
  network = await serveHttp((request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/ontos/cart")
      return new Response("Unknown endpoint", { status: 404 });
    return Response.json({
      cart,
      priceChanged: false,
      issues: [message],
      lineIssues: [{ productId: "p", variantId: "v", code: "AVAILABILITY_UNKNOWN", message }],
      canCheckout: false,
      totals: null,
    });
  });
  browserAt(network.origin);
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
  await network.idle();
  expect(screen.getByText("Nelze ověřit")).toBeTruthy();
  expect(screen.queryByText("Skladem")).toBeNull();
  expect(screen.getAllByText(message).length).toBeGreaterThan(0);
  expect(
    (screen.getByRole("button", { name: "Vybrat dopravu a platbu" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
