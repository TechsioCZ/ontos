import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CartProvider } from "@/features/cart/cart-provider";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";
import { CartQuoteProvider } from "@/ontos/cart-revalidation";
import { DeliveryPaymentStep } from "@/features/checkout/delivery-payment-step";
import { AddressStep } from "@/features/checkout/address-step";
import type { ReactNode } from "react";
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/checkout")
        ? Response.json({
            shippingMethods: [{ id: "PPL", title: "Owner shipping", priceMinor: 12900 }],
          })
        : Response.json({ account: null }),
    ),
  );
});
function renderStep(child: ReactNode) {
  return render(
    <CartProvider storage={null}>
      <CheckoutProvider>
        <CartQuoteProvider>{child}</CartQuoteProvider>
      </CheckoutProvider>
    </CartProvider>,
  );
}
it("offers only owner shipping tariffs and never fictitious pickup locations or payment methods", async () => {
  const user = userEvent.setup();
  renderStep(<DeliveryPaymentStep />);
  const radio = await screen.findByRole("radio", { name: /Owner shipping/ });
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText("Objednávka bez online platby")).toBeTruthy();
  await user.click(radio);
  await user.click(screen.getByRole("button", { name: "Dodací údaje" }));
  expect(router.push).toHaveBeenCalledWith("/kosik/dodaci-udaje");
});
it("shows initially empty editable addresses and blocks incomplete delivery data", async () => {
  const user = userEvent.setup();
  renderStep(<AddressStep />);
  const email = screen.getByLabelText(/E-mail/);
  expect((email as HTMLInputElement).value).toBe("");
  await user.click(screen.getByRole("button", { name: "Souhrn objednávky" }));
  expect(router.push).not.toHaveBeenCalled();
  expect(screen.getByText("Zadejte platný e-mail.")).toBeTruthy();
  await user.type(email, "entered@example.test");
  expect(JSON.parse(sessionStorage.getItem("akros-checkout-v2")!).draft.email).toBe(
    "entered@example.test",
  );
});
