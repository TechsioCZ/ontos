import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CategoryFilters } from "@/components/category-filters";
import { ProductDetailActions, ProductFavoriteButton } from "@/components/product-detail-actions";
import { CartProvider } from "@/features/cart/cart-provider";
import { CartContent } from "@/features/cart/cart-content";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { CheckoutProvider } from "@/features/checkout/checkout-provider";
import { parseCategoryFilters } from "@/ontos/category-filters";
import { MarketProvider, type ClientMarket } from "@/ontos/market-context";
import type { CatalogProduct, CatalogProductVariant } from "@/ontos/catalog-types";

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
const csMarket = market("cs", "CZK");

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

const renderCart = (localeMarket: ClientMarket) =>
  render(
    <MarketProvider market={localeMarket}>
      <CartProvider storage={window.localStorage}>
        <CheckoutProvider storage={window.sessionStorage}>
          <CartContent />
        </CheckoutProvider>
      </CartProvider>
    </MarketProvider>,
  );

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem(
    "akros-demo-cart-v3",
    JSON.stringify({ version: 3, lines: [cartLine] }),
  );
});

afterEach(cleanup);

describe("market copy outside the product cards", () => {
  it("shows the Slovak category filters", () => {
    render(
      <MarketProvider market={skMarket}>
        <CategoryFilters filters={parseCategoryFilters({})} pathname="/kategorie/vrut" count={7} />
      </MarketProvider>,
    );

    expect(screen.getByLabelText("Názov alebo SKU")).not.toBeNull();
    expect(screen.getByPlaceholderText("Hľadať v kategórii")).not.toBeNull();
    expect(screen.getAllByPlaceholderText("Bez obmedzenia")).toHaveLength(2);
    expect(screen.getByText(/Nájdených produktov/)).not.toBeNull();
    expect(screen.getByText("Vymazať filtre")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Filtrovať" })).not.toBeNull();
    expect(screen.queryByText("Nalezeno produktů")).toBeNull();
    expect(screen.queryByText("Vymazat filtry")).toBeNull();
  });

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

  it("keeps the Czech category filters in Czech", () => {
    render(
      <MarketProvider market={csMarket}>
        <CategoryFilters filters={parseCategoryFilters({})} pathname="/kategorie/vrut" count={2} />
      </MarketProvider>,
    );

    expect(screen.getByText(/Nalezeno produktů/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Filtrovat" })).not.toBeNull();
  });

  it("shows the Slovak cart, including the line controls", () => {
    renderCart(skMarket);

    expect(screen.getByRole("heading", { name: "Obsah košíka" })).not.toBeNull();
    expect(screen.getByRole("table", { name: "Položky objednávky" })).not.toBeNull();
    expect(screen.getByText("Dostupnosť")).not.toBeNull();
    expect(screen.getByText("Množstvo")).not.toBeNull();
    expect(screen.getByText("Cena")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Odobrať DIN 933/A2" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Znížiť množstvo: DIN 933/A2" })).not.toBeNull();
    expect(screen.getByText(/Aktuálne spôsoby a ceny dopravy/)).not.toBeNull();
    expect(screen.queryByText("Obsah košíku")).toBeNull();
    expect(screen.queryByText("Dostupnost")).toBeNull();
  });

  it("shows the English cart", () => {
    renderCart(enMarket);

    expect(screen.getByRole("heading", { name: "Cart contents" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove DIN 933/A2" })).not.toBeNull();
    expect(screen.getByText(/Current shipping methods and prices/)).not.toBeNull();
    expect(screen.queryByText("Odebrat")).toBeNull();
  });

  it("shows the Slovak variant table of the product detail", () => {
    render(
      <MarketProvider market={skMarket}>
        <CartProvider storage={window.localStorage}>
          <ProductPurchaseForm product={product} variants={variants} />
        </CartProvider>
      </MarketProvider>,
    );

    expect(screen.getByRole("table", { name: "Varianty produktu" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Filtruj" })).not.toBeNull();
    expect(screen.getByText("Názov")).not.toBeNull();
    expect(screen.getByText("M.J.")).not.toBeNull();
    expect(screen.getAllByText("Skladom").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nie je skladom").length).toBeGreaterThan(0);
    expect(screen.queryByText("Skladem")).toBeNull();
    expect(screen.queryByText("Není skladem")).toBeNull();
  });

  it("shows the English purchase form of a single-variant product", () => {
    render(
      <MarketProvider market={enMarket}>
        <CartProvider storage={window.localStorage}>
          <ProductPurchaseForm product={{ ...product, quantityStep: 100, packageQuantity: 100 }} />
        </CartProvider>
      </MarketProvider>,
    );

    expect(screen.getByRole("button", { name: "Buy" })).not.toBeNull();
    expect(screen.getByText("Whole packages only, 100 ks each.")).not.toBeNull();
    expect(screen.queryByText(/Pouze celá balení/)).toBeNull();
  });

  it("shows the English product actions", () => {
    render(
      <MarketProvider market={enMarket}>
        <ProductDetailActions productId="product-hex-bolt" productName="DIN 933/A2" />
        <ProductFavoriteButton productId="product-hex-bolt" productName="DIN 933/A2" />
      </MarketProvider>,
    );

    expect(screen.getByRole("link", { name: "Ask about the product" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send to a friend" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add DIN 933/A2 to favourites" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add DIN 933/A2 to favourites" }));
    expect(
      screen.getByRole("button", { name: "Remove DIN 933/A2 from favourites" }),
    ).not.toBeNull();
  });
});
