import { settleBrowser } from "../support/browser";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";
import { browserAt, serveHttp } from "../support/http";
import { renderStorefront as render } from "../support/storefront";
import { CheckoutProvider, useCheckout } from "@/features/checkout/checkout-provider";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { createCheckoutDraft } from "@/features/checkout/checkout-state";

function Probe() {
  const { ready, draft, accountEmail, methods, storageError, completeOrder, updateDraft } =
    useCheckout();
  const { cart } = useCart();
  return (
    <>
      <output aria-label="Ready">{String(ready && !!accountEmail && !!methods.length)}</output>
      <output aria-label="Contact">{draft.email}</output>
      <output aria-label="Company">{draft.company}</output>
      <output aria-label="Cart">{cart.lines.length}</output>
      <output aria-label="Error">{storageError}</output>
      <button onClick={() => updateDraft((value) => ({ ...value, company: "Edited" }))}>
        Edit
      </button>
      <button onClick={() => completeOrder()}>Submit</button>
    </>
  );
}
let network: Awaited<ReturnType<typeof serveHttp>>;

afterEach(async () => {
  cleanup();
  await network.idle();
  await network.close();
});
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  network = await serveHttp((request) => {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/api/ontos/checkout")
      return Response.json({ shippingMethods: [{ id: "PPL", title: "PPL", priceMinor: 12900 }] });
    if (request.method === "GET" && pathname === "/api/ontos/account")
      return Response.json({ account: { email: "verified@example.test", name: "Customer" } });
    return Response.json({}, { status: 503 });
  });
  browserAt(network.origin);
});
it("starts with empty address fields and prefills only the real admitted account email", async () => {
  render(
    <CartProvider storage={null}>
      <CheckoutProvider>
        <Probe />
      </CheckoutProvider>
    </CartProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText("Ready").textContent).toBe("true"));
  expect(screen.getByLabelText("Contact").textContent).toBe("verified@example.test");
  const saved = JSON.parse(sessionStorage.getItem("sf-checkout-v2")!);
  expect(saved.draft.billing.street).toBe("");
  expect(saved.draft.billing.firstName).toBe("");
});
it("restores unfinished customer-entered drafts without inventing a saved order", async () => {
  const user = userEvent.setup();
  sessionStorage.setItem(
    "sf-checkout-v2",
    JSON.stringify({ version: 1, draft: { ...createCheckoutDraft(), company: "Entered" } }),
  );
  render(
    <CartProvider storage={null}>
      <CheckoutProvider>
        <Probe />
      </CheckoutProvider>
    </CartProvider>,
  );
  await waitFor(() => expect(screen.getByLabelText("Ready").textContent).toBe("true"));
  expect(screen.getByLabelText("Company").textContent).toBe("Entered");
  await user.click(screen.getByText("Edit"));
  expect(JSON.parse(sessionStorage.getItem("sf-checkout-v2")!).draft.company).toBe("Edited");
  await settleBrowser();
  expect(sessionStorage.getItem("akros-demo-order-v1")).toBeNull();
});
