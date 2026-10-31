import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
      <output aria-label="Cart">{cart.lines.length}</output>
      <output aria-label="Error">{storageError}</output>
      <button onClick={() => updateDraft((value) => ({ ...value, company: "Edited" }))}>
        Edit
      </button>
      <button onClick={() => completeOrder()}>Submit</button>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/checkout"))
        return Response.json({ shippingMethods: [{ id: "PPL", title: "PPL", priceMinor: 12900 }] });
      if (url.endsWith("/account"))
        return Response.json({ account: { email: "verified@example.test", name: "Customer" } });
      return Response.json({}, { status: 503 });
    }),
  );
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
  const saved = JSON.parse(sessionStorage.getItem("akros-checkout-v2")!);
  expect(saved.draft.billing.street).toBe("");
  expect(saved.draft.billing.firstName).toBe("");
});
it("restores unfinished customer-entered drafts without inventing a saved order", async () => {
  const user = userEvent.setup();
  sessionStorage.setItem(
    "akros-checkout-v2",
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
  await user.click(screen.getByText("Edit"));
  expect(JSON.parse(sessionStorage.getItem("akros-checkout-v2")!).draft.company).toBe("Edited");
  expect(sessionStorage.getItem("akros-demo-order-v1")).toBeNull();
});
