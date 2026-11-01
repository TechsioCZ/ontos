import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import StoreLink from "@/components/store-link";
import { CartProvider, useCart } from "@/features/cart/cart-provider";
import { MarketProvider, useFormatPrice, type ClientMarket } from "@/ontos/market-context";
import { MarketSwitcher } from "@/ontos/market-switcher";

const live: ClientMarket["live"] = [
  { locale: "cs", marketCode: "AKROS-CZ", label: "CZ", currency: "CZK" },
  { locale: "sk", marketCode: "AKROS-SK", label: "SK", currency: "EUR" },
  { locale: "en", marketCode: "AKROS-EU", label: "EN", currency: "EUR" },
];
const slovak: ClientMarket = {
  locale: "sk",
  marketCode: "AKROS-SK",
  currency: "EUR",
  formatLocale: "sk",
  configured: true,
  live,
};

const cartLine = {
  productId: "p",
  slug: "vrut",
  name: "Vrut",
  sku: "V-1",
  imageSrc: "/v.png",
  imageAlt: "Vrut",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 10,
  priceMinor: 123,
  quantity: 2,
};
const storedCart = (priceMinor: number) =>
  JSON.stringify({
    version: 1,
    activeCartId: "default",
    carts: [
      {
        id: "default",
        name: "Výchozí košík",
        cart: { version: 3, lines: [{ ...cartLine, priceMinor }] },
      },
    ],
  });

function CartPrice() {
  const { cart, ready } = useCart();
  const formatPrice = useFormatPrice();
  return (
    <output aria-label="cena">{ready ? formatPrice(cart.lines[0]?.priceMinor ?? 0) : ""}</output>
  );
}

afterEach(cleanup);

describe("market links", () => {
  it("prefixes internal store links with the market locale", () => {
    render(
      <MarketProvider market={slovak}>
        <StoreLink href="/kosik">Košík</StoreLink>
        <StoreLink href="/">Domov</StoreLink>
        <StoreLink href={{ pathname: "/vyhledavani", query: { q: "vrut" } }}>Hľadať</StoreLink>
        <StoreLink href="/sk/kontakty">Kontakty</StoreLink>
        <StoreLink href="https://www.akroscz.cz/">Výroba</StoreLink>
      </MarketProvider>,
    );
    const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("Košík")).toBe("/sk/kosik");
    expect(href("Domov")).toBe("/sk");
    expect(href("Hľadať")).toBe("/sk/vyhledavani?q=vrut");
    expect(href("Kontakty")).toBe("/sk/kontakty");
    expect(href("Výroba")).toBe("https://www.akroscz.cz/");
  });

  it("keeps hrefs unprefixed outside a market", () => {
    render(<StoreLink href="/kosik">Košík</StoreLink>);
    expect(screen.getByRole("link", { name: "Košík" }).getAttribute("href")).toBe("/kosik");
  });

  it("lists the live markets as full-page links, marking the current one", () => {
    render(
      <MarketProvider market={slovak}>
        <MarketSwitcher />
      </MarketProvider>,
    );
    const switcher = screen.getByRole("navigation", { name: "Trh a jazyk" });
    const links = [...switcher.querySelectorAll("a")];
    expect(
      links.map((link) => [link.textContent?.replace(/\u00a0/gu, " "), link.getAttribute("href")]),
    ).toEqual([
      ["CZ · Kč", "/cs"],
      ["SK · €", "/sk"],
      ["EN · €", "/en"],
    ]);
    expect(links[1].getAttribute("aria-current")).toBe("page");
  });
});

describe("market carts", () => {
  it("stores the carts of each market under their own key", async () => {
    const storage = window.localStorage;
    storage.clear();
    storage.setItem("akros-demo-carts-v1:AKROS-CZ", storedCart(12_100));
    storage.setItem("akros-demo-carts-v1:AKROS-SK", storedCart(480));
    render(
      <MarketProvider market={slovak}>
        <CartProvider storage={storage} storageScope="AKROS-SK">
          <CartPrice />
        </CartProvider>
      </MarketProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("cena").textContent?.replace(/\u00a0/gu, " ")).toBe("4,80 €"),
    );
    await waitFor(() =>
      expect(
        JSON.parse(storage.getItem("akros-demo-cart-v3:AKROS-SK") ?? "{}").lines[0].priceMinor,
      ).toBe(480),
    );
    // The Czech market's carts are untouched by the Slovak document.
    expect(
      JSON.parse(storage.getItem("akros-demo-carts-v1:AKROS-CZ") ?? "{}").carts[0].cart.lines[0]
        .priceMinor,
    ).toBe(12_100);
    expect(storage.getItem("akros-demo-cart-v3")).toBeNull();
  });
});
