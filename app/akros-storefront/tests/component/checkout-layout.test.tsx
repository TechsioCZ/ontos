import "next/dist/client/app-bootstrap";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentAppRouterState } from "next/dist/client/components/app-router-instance";
import { NextRouter } from "../support/router";
import { browserAt, serveHttp } from "../support/http";
import { fixtureSnapshot } from "../support/storefront";
import { BrandProvider } from "@/brand/brand-context";
import { akros } from "@/brand/akros";
import { toClientBrand } from "@/brand";
import { CatalogProvider } from "@/ontos/catalog-provider";
import { CartContent } from "@/features/cart/cart-content";
import { CartProvider } from "@/features/cart/cart-provider";
import { CheckoutLayout } from "@/features/checkout/checkout-layout";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";

let network: Awaited<ReturnType<typeof serveHttp>>;
let accountEmail: string | null;
let allowNavigation: () => void;
let accountArrived: Promise<void>;
let shippingArrived: Promise<void>;
let navigationArrived: Promise<void>;

beforeEach(async () => {
  accountEmail = null;
  const account = Promise.withResolvers<void>();
  const shipping = Promise.withResolvers<void>();
  const destination = Promise.withResolvers<void>();
  accountArrived = account.promise;
  shippingArrived = shipping.promise;
  navigationArrived = destination.promise;
  const navigation = new Promise<void>((resolve) => {
    allowNavigation = resolve;
  });
  network = await serveHttp(async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/ontos/account") {
      account.resolve();
      return Response.json({ account: accountEmail ? { email: accountEmail } : null });
    }
    if (pathname === "/api/ontos/checkout") {
      shipping.resolve();
      return Response.json({ shippingMethods: [] });
    }
    if (pathname === "/kosik/doprava-platba") {
      destination.resolve();
      await navigation;
      return new Response("<!doctype html><title>Doprava a platba</title>", {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("Unknown endpoint", { status: 404 });
  });
  browserAt(`${network.origin}/kosik`);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(async () => {
  allowNavigation();
  cleanup();
  await network.idle();
  await network.close();
});

async function renderCart() {
  await act(async () => {
    render(
      <BrandProvider brand={toClientBrand(akros, "cs")}>
        <CatalogProvider snapshot={fixtureSnapshot}>
          <NextRouter>
            <CartProvider>
              <CheckoutProvider>
                <CheckoutLayout recommendations={[]}>
                  <CartContent />
                </CheckoutLayout>
              </CheckoutProvider>
            </CartProvider>
          </NextRouter>
        </CatalogProvider>
      </BrandProvider>,
    );
  });
  await act(async () => {
    await Promise.all([accountArrived, shippingArrived]);
    await network.idle();
  });
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
    await renderCart();
    const items = await screen.findByRole("region", { name: "Obsah košíku" });
    const summary = screen.getByRole("complementary", { name: "Shrnutí" });
    const next = await screen.findByRole("link", { name: "Přihlásit se" });
    expect(screen.getByRole("button", { name: "Objednat bez registrace" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Vybrat dopravu a platbu" })).toBeNull();
    expect(screen.getByRole("link", { name: "Vytvořit účet" }).getAttribute("href")).toContain(
      "/registrace",
    );
    expect(screen.getByRole("button", { name: "Doprava a platba" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getAllByRole("complementary", { name: "Shrnutí" })).toHaveLength(1);
    expect(items.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(items.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.getByRole("region", { name: "Vaše košíky" })).not.toBeNull();
    expect(next.getAttribute("href")).toBe("/prihlaseni?returnTo=%2Fkosik");
  });

  it("lets a verified customer continue without discarding the cart", async () => {
    seedCart();
    accountEmail = "customer@example.test";
    await renderCart();
    const next = await screen.findByRole("link", { name: "Vybrat dopravu a platbu" });
    expect(next.getAttribute("href")).toBe("/kosik/doprava-platba");
    expect(screen.queryByRole("link", { name: "Přihlásit se" })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("akros-demo-cart-v3")!).lines).toHaveLength(1);
  });

  it("hides the summary and checkout action when the cart is empty", async () => {
    await renderCart();
    expect(await screen.findByText("Košík je zatím prázdný.")).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "Shrnutí" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Vybrat dopravu a platbu" })).toBeNull();
    expect(screen.getByRole("link", { name: "Zpět do katalogu" })).not.toBeNull();
  });
  it("continues as a guest and remembers the choice for the rest of the checkout", async () => {
    seedCart();
    const user = userEvent.setup();
    await renderCart();
    const guest = await screen.findByRole("button", { name: "Objednat bez registrace" });
    await act(async () => {
      await user.click(guest);
    });
    expect(window.sessionStorage.getItem("sf-checkout-guest")).toBe("true");
    expect(screen.getByRole("button", { name: "Doprava a platba" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(await screen.findByRole("link", { name: "Vybrat dopravu a platbu" })).not.toBeNull();
    await navigationArrived;
    allowNavigation();
    await waitFor(() =>
      expect(getCurrentAppRouterState()?.canonicalUrl).toBe("/kosik/doprava-platba"),
    );
    await network.idle();
    expect(
      network.requests.some((request) => new URL(request.url).pathname === "/kosik/doprava-platba"),
    ).toBe(true);
  });
});
