import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CategoryFilters } from "@/components/category-filters";
import { AddressStep } from "@/features/checkout/address-step";
import { ProductDetailActions } from "@/components/product-detail-actions";
import { CartProvider } from "@/features/cart/cart-provider";
import { CartNotifications } from "@/features/cart/cart-notifications";
import { AddToCartButton } from "@/features/cart/add-to-cart-button";
import { toaster } from "@techsio/ui-kit/molecules/toast";
import { cs } from "@/i18n/cs";
import { CZK_MONEY, priceUnavailableText } from "@/lib/format";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";
import { FavoriteButton } from "@/features/favorites/favorite-button";
import { parseCategoryFilters } from "@/ontos/category-filters";
import { MarketProvider, type ClientMarket } from "@/ontos/market-context";
import type { CatalogProduct, CatalogProductVariant } from "@/ontos/catalog-types";

import { browserAt, serveHttp } from "../support/http";
// Initialize Next's own browser runtime before mounting its real router.
import "next/dist/client/app-bootstrap";
import { NextRouter } from "../support/router";

const live: ClientMarket["live"] = [
  { locale: "cs", marketCode: "AKROS-CZ", label: "CZ", currency: "CZK" },
  { locale: "sk", marketCode: "AKROS-SK", label: "SK", currency: "EUR" },
  { locale: "en", marketCode: "AKROS-EU", label: "EN", currency: "EUR" },
];

const market = (locale: "cs" | "sk" | "en", currency: "CZK" | "EUR"): ClientMarket => ({
  locale,
  marketCode: locale === "cs" ? "AKROS-CZ" : locale === "sk" ? "AKROS-SK" : "AKROS-EU",
  currency,
  formatLocale: locale === "sk" ? "sk-SK" : locale === "en" ? "en-GB" : "cs-CZ",
  configured: true,
  live,
});

const skMarket = market("sk", "EUR");
const enMarket = market("en", "EUR");

const variants: CatalogProductVariant[] = [
  {
    id: "item-1",
    sourceId: "1",
    sku: "10093300020005",
    label: "M 2 × 5",
    minimumQuantity: 10,
    priceMinor: 84,
    stockCount: 24_000,
    unit: "ks",
    priceTiers: [],
    parameters: [],
    isAction: false,
    isRecommended: false,
    isSale: false,
    isNew: false,
  },
  {
    id: "item-2",
    sourceId: "2",
    sku: "10093300040016",
    label: "M 4 × 16",
    minimumQuantity: 10,
    priceMinor: 194,
    stockCount: 0,
    unit: "ks",
    priceTiers: [],
    parameters: [],
    isAction: false,
    isRecommended: false,
    isSale: false,
    isNew: false,
  },
];

const product: CatalogProduct = {
  id: "product-hex-bolt",
  slug: "hex-bolt",
  categoryId: "bolts",
  name: "DIN 933/A2",
  sku: "10093300",
  description: "",
  priceMinor: 84,
  currency: "EUR",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 32_500,
  imageSrc: "/bolt.png",
  imageAlt: "Bolt",
  featuredPosition: null,
  variantSummary: { count: 2, minGrossPriceMinor: 84, stockOnHand: 32_500, units: ["ks"] },
  isAction: false,
  isRecommended: false,
  isSale: false,
  isNew: false,
  detail: { descriptionParagraphs: [], parameters: [], priceTiers: [], variants },
};

const cartLine = {
  productId: "product-hex-bolt",
  slug: "hex-bolt",
  name: "DIN 933/A2",
  sku: "10093300",
  imageSrc: "/bolt.png",
  imageAlt: "Bolt",
  unit: "ks",
  minimumQuantity: 1,
  stockCount: 32_500,
  priceMinor: 84,
  quantity: 2,
};

let network: Awaited<ReturnType<typeof serveHttp>>;
let cartUnavailable = false;

beforeEach(async () => {
  cartUnavailable = false;
  network = await serveHttp(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/ontos/checkout" && request.method === "GET")
      return Response.json({ shippingMethods: [] });
    if (path === "/api/ontos/account" && request.method === "GET")
      return Response.json({ account: null });
    if (path === "/api/ontos/cart" && request.method === "POST") {
      if (cartUnavailable) return Response.json({ error: "down" }, { status: 503 });
      const { cart } = await request.json();
      return Response.json({ cart, priceChanged: false, issues: [], canCheckout: true });
    }
    return new Response("Unknown endpoint", { status: 404 });
  });
  browserAt(network.origin);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem(
    "akros-demo-cart-v3",
    JSON.stringify({ version: 3, lines: [cartLine] }),
  );
});

afterEach(async () => {
  cleanup();
  toaster.remove();
  await network.idle();
  await network.close();
});

describe("market copy outside the product cards", () => {
  it("shows the English category filters and its invalid range warning", () => {
    render(
      <MarketProvider market={enMarket}>
        <CategoryFilters
          filters={parseCategoryFilters({ min: "20", max: "10" })}
          pathname="/kategorie/vrut"
          count={0}
        />
      </MarketProvider>,
    );

    expect(screen.getByLabelText("Name or SKU")).not.toBeNull();
    expect(screen.getByText(/Products found/)).not.toBeNull();
    expect(screen.getByText("Clear filters")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Filter" })).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "The minimum price must not be higher than the maximum price.",
    );
  });

  it("names the starter carts in the market's language", async () => {
    render(
      <MarketProvider market={skMarket}>
        <CartProvider storage={window.localStorage}>
          <span />
        </CartProvider>
      </MarketProvider>,
    );

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("akros-demo-carts-v1") ?? "{}");
      expect((stored.carts ?? []).map((cart: { name: string }) => cart.name)).toEqual([
        "Predvolený košík",
        "Komisný košík",
      ]);
    });
  });

  it("shows the English product actions", () => {
    browserAt(`${network.origin}/en/produkt/hex-bolt`);
    render(
      <NextRouter>
        <MarketProvider market={enMarket}>
          <ProductDetailActions
            productId="product-hex-bolt"
            productName="DIN 933/A2"
            productSlug="hex-bolt"
            showVariantFavorites
          />
          <FavoriteButton
            productId="product-hex-bolt"
            productName="DIN 933/A2"
            productSlug="hex-bolt"
            variantId={null}
          />
        </MarketProvider>
      </NextRouter>,
    );

    expect(screen.getByRole("button", { name: "Ask about the product" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Watch product" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Share" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Print" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Choose favourite variants: DIN 933/A2, 0 saved" }),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save DIN 933/A2 to favourites" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save DIN 933/A2 to favourites" }));
    expect(
      screen.getByRole("button", { name: "Remove DIN 933/A2 from favourites" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Choose favourite variants: DIN 933/A2, 1 saved" }),
    ).not.toBeNull();
  });

  it("shows the Slovak delivery details step and its validation", async () => {
    browserAt(`${network.origin}/sk/kosik/dodaci-udaje`);
    render(
      <NextRouter>
        <MarketProvider market={skMarket}>
          <CartProvider storage={window.localStorage}>
            <CheckoutProvider storage={window.sessionStorage}>
              <AddressStep />
            </CheckoutProvider>
          </CartProvider>
        </MarketProvider>
      </NextRouter>,
    );

    expect(screen.getByRole("heading", { name: "Dodacie údaje" })).not.toBeNull();
    expect(screen.getByText("Fakturačná adresa")).not.toBeNull();
    expect(screen.getByLabelText(/Priezvisko/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Súhrn objednávky" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Súhrn objednávky" }));
    await waitFor(() => expect(screen.getByText("Zadajte platný e-mail.")).not.toBeNull());
    expect(screen.getAllByText("Vyplňte toto pole.").length).toBeGreaterThan(0);
    expect(screen.queryByText("Zadejte platný e-mail.")).toBeNull();
    expect(screen.queryByText("Fakturační adresa")).toBeNull();
    await waitFor(() => {
      expect(network.requests.map((request) => new URL(request.url).pathname)).toEqual(
        expect.arrayContaining(["/api/ontos/checkout", "/api/ontos/account"]),
      );
    });
    await act(async () => network.idle());
  });

  it("words the price-unavailable reason code in Slovak and English, Czech unchanged", () => {
    const priced = (reason: string) =>
      variants.map((variant, index) =>
        index === 0 ? { ...variant, priceUnavailableReason: reason } : variant,
      );
    render(
      <MarketProvider market={skMarket}>
        <CartProvider storage={window.localStorage}>
          <ProductPurchaseForm product={product} variants={priced("currency:CZK")} />
        </CartProvider>
      </MarketProvider>,
    );
    expect(
      screen.getByText("Cena je v nepodporovanej mene (CZK); e-shop predáva len v €."),
    ).not.toBeNull();
    expect(screen.queryByText(/nepodporované měně/)).toBeNull();
    cleanup();

    render(
      <MarketProvider market={enMarket}>
        <CartProvider storage={window.localStorage}>
          <ProductPurchaseForm product={product} variants={priced("zero-price")} />
        </CartProvider>
      </MarketProvider>,
    );
    expect(
      screen.getByText("The price in OntOS is zero, so this item cannot be ordered."),
    ).not.toBeNull();
    expect(screen.queryByText(/nulová/)).toBeNull();

    expect(priceUnavailableText("currency:EUR", cs, CZK_MONEY)).toBe(
      "Cena je v nepodporované měně (EUR); e-shop prodává jen v Kč.",
    );
    expect(priceUnavailableText("missing-price", cs)).toBe("OntOS pro tuto položku nevrátil cenu.");
  });

  it("shows the cart toasts and add failures in the market's language", async () => {
    const item = { ...cartLine, productId: "product-washer", slug: "washer", name: "Washer" };
    const renderAdd = (localeMarket: ClientMarket) =>
      render(
        <MarketProvider market={localeMarket}>
          <CartProvider storage={window.localStorage}>
            <AddToCartButton item={item} quantity={3} />
            <CartNotifications />
          </CartProvider>
        </MarketProvider>,
      );
    renderAdd(enMarket);
    fireEvent.click(await screen.findByRole("button", { name: /Washer/ }));
    expect(await screen.findByText("Added to cart")).not.toBeNull();
    expect(screen.getByText("Added 3 ks.")).not.toBeNull();
    expect(screen.getByRole("link", { name: "View cart" })).not.toBeNull();
    expect(screen.queryByText("Přidáno do košíku")).toBeNull();
    cleanup();
    toaster.remove();

    cartUnavailable = true;
    renderAdd(skMarket);
    fireEvent.click(await screen.findByRole("button", { name: /Washer/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Cenu a skladovú dostupnosť teraz nemožno overiť v OntOS. Tovar nebol pridaný.",
    );
  });
});
