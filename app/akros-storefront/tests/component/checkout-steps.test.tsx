import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CartProvider } from "@/features/cart/cart-provider";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";
import { DeliveryPaymentStep } from "@/features/checkout/delivery-payment-step";
import { AddressStep } from "@/features/checkout/address-step";
import { createCheckoutDraft } from "@/mock-storefront/checkout";
import type { ReactNode } from "react";

const router = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  replace: vi.fn<(href: string) => void>(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
afterEach(cleanup);
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});
function renderStep(child: ReactNode) {
  return render(
    <CartProvider>
      <CheckoutProvider>{child}</CheckoutProvider>
    </CartProvider>,
  );
}

describe("checkout step interactions", () => {
  it("requires shipping and payment before continuing", async () => {
    const user = userEvent.setup();
    renderStep(<DeliveryPaymentStep />);
    await user.click(screen.getByRole("button", { name: "Dodací údaje" }));
    expect(screen.getByText("Vyberte způsob dopravy.")).not.toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Zásilkovna" })),
    );
    await user.click(screen.getByRole("radio", { name: /DPD Parcel/ }));
    await user.click(screen.getByRole("radio", { name: "GoPay" }));
    await user.click(screen.getByRole("button", { name: "Dodací údaje" }));
    expect(router.push).toHaveBeenCalledWith("/kosik/dodaci-udaje");
  });

  it("keeps another address draft when toggled off and on, and blocks incomplete addresses", async () => {
    const user = userEvent.setup();
    renderStep(<AddressStep />);
    const checkbox = screen.getByRole("checkbox", { name: /jinou adresu/ });
    await user.click(checkbox);
    await user.type(screen.getByLabelText("Jméno", { exact: false }), "Petra");
    await user.click(checkbox);
    await user.click(checkbox);
    expect(screen.getByLabelText("Jméno", { exact: false }).getAttribute("value")).toBe("Petra");
    await user.click(screen.getByRole("button", { name: "Souhrn objednávky" }));
    expect(router.push).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Příjmení/)));
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Souhrn objednávky" }));
    expect(router.push).toHaveBeenCalledWith("/kosik/shrnuti");
  });

  it("edits the prefilled billing contact instead of discarding entered values", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      "akros-demo-checkout-v1",
      JSON.stringify({ version: 1, draft: createCheckoutDraft() }),
    );
    renderStep(<AddressStep />);
    await user.click(screen.getByRole("button", { name: "Změnit fakturační údaje" }));
    const email = screen.getByLabelText(/E-mail/);
    await user.clear(email);
    await user.type(email, "edited@example.cz");
    await user.click(screen.getByRole("button", { name: "Uložit údaje" }));
    expect(screen.getByText("edited@example.cz")).not.toBeNull();
    expect(
      JSON.parse(window.sessionStorage.getItem("akros-demo-checkout-v1") ?? "null").draft.email,
    ).toBe("edited@example.cz");
  });
});
