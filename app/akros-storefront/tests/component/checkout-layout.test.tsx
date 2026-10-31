import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CartContent } from "@/features/cart/cart-content";
import { CartProvider } from "@/features/cart/cart-provider";
import { CheckoutLayout } from "@/features/checkout/checkout-layout";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";

const router = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  replace: vi.fn<(href: string) => void>(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/kosik",
  useRouter: () => router,
}));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "checkout-font" }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function renderCart() {
  return render(
    <CartProvider>
      <CheckoutProvider>
        <CheckoutLayout recommendations={[]}>
          <CartContent />
        </CheckoutLayout>
      </CheckoutProvider>
    </CartProvider>,
  );
}

function seedCart() {
  window.localStorage.setItem(
    "akros-demo-cart-v3",
    JSON.stringify({
      version: 3,
      lines: [
        {
          productId: "screw",
          slug: "screw",
          name: "Vrut",
          sku: "A2",
          imageSrc: "/screw.jpg",
          imageAlt: "Vrut",
          unit: "ks",
          minimumQuantity: 1,
          stockCount: 100,
          priceMinor: 100,
          quantity: 30,
        },
      ],
    }),
  );
}

describe("checkout cart composition", () => {
  it("renders one summary and lets a signed-out customer choose guest ordering, sign-in or registration", async () => {
    seedCart();
    renderCart();
    const items = await screen.findByRole("region", { name: "Obsah košíku" });
    const summary = screen.getByRole("complementary", { name: "Shrnutí" });
    const next = await screen.findByRole("link", { name: "Přihlásit se" });
    expect(screen.getByRole("button", { name: "Objednat bez registrace" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Vybrat dopravu a platbu" })).toBeNull();
    expect(screen.getByRole("link", { name: "Vytvořit účet" }).getAttribute("href")).toContain(
      "/registrace",
    );
    expect(screen.getByRole("tab", { name: "Doprava a platba" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getAllByRole("complementary", { name: "Shrnutí" })).toHaveLength(1);
    expect(items.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(items.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByRole("region", { name: "Vaše košíky" })).not.toBeNull();
    expect(next.getAttribute("href")).toBe("/prihlaseni?returnTo=%2Fkosik");
  });

  it("continues as a guest and remembers the choice for the rest of the checkout", async () => {
    seedCart();
    const user = userEvent.setup();
    renderCart();
    await user.click(await screen.findByRole("button", { name: "Objednat bez registrace" }));
    expect(router.push).toHaveBeenCalledWith("/kosik/doprava-platba");
    expect(window.sessionStorage.getItem("akros-checkout-guest")).toBe("true");
    expect(screen.getByRole("tab", { name: "Doprava a platba" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(await screen.findByRole("link", { name: "Vybrat dopravu a platbu" })).not.toBeNull();
  });

  it("lets a verified customer continue without discarding the cart", async () => {
    seedCart();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/account"))
          return Response.json({ account: { email: "customer@example.test" } });
        if (url.endsWith("/checkout")) return Response.json({ shippingMethods: [] });
        return Response.json({ canCheckout: true, priceChanged: false, issues: [] });
      }),
    );
    renderCart();
    const next = await screen.findByRole("link", { name: "Vybrat dopravu a platbu" });
    expect(next.getAttribute("href")).toBe("/kosik/doprava-platba");
    expect(screen.queryByRole("link", { name: "Přihlásit se" })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("akros-demo-cart-v3")!).lines).toHaveLength(1);
  });

  it("hides the summary and checkout action when the cart is empty", async () => {
    renderCart();
    expect(await screen.findByText("Košík je zatím prázdný.")).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "Shrnutí" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Vybrat dopravu a platbu" })).toBeNull();
    expect(screen.getByRole("link", { name: "Zpět do katalogu" })).not.toBeNull();
  });
});
