import type { ReactElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateMetadata } from "@/app/layout";
import { getBrand, toClientBrand } from "@/brand";
import { BrandProvider } from "@/brand/brand-context";
import { CartProvider } from "@/features/cart/cart-provider";
import { MarketGatePage } from "@/ontos/market-pages";
import { MarketProvider, type ClientMarket } from "@/ontos/market-context";
import { Unavailable } from "@/ontos/unavailable";
import { dictionaryFor } from "@/i18n";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { CatalogSidebar } from "@/components/catalog-sidebar";
import HomePage from "@/app/page";
import AboutPage from "@/app/o-nas/page";
import ContactsPage from "@/app/kontakty/page";
import TermsPage from "@/app/obchodni-podminky/page";
import PrivacyPage from "@/app/gdpr/page";
import ClaimsPage from "@/app/reklamace/page";
import PartnerPage from "@/app/partnersky-program/page";
import FaqPage from "@/app/faq/page";
import BlogPage from "@/app/blog/page";
import NewsPage from "@/app/novinky-a-akce/page";
import LoginPage from "@/app/prihlaseni/page";
import ShippingPage from "@/app/doprava-a-platba/page";
import ManufacturingPage, {
  generateMetadata as manufacturingMetadata,
} from "@/app/kategorie/akroscz-vyroba/page";
import NotFoundPage from "@/app/not-found";
import GlobalError from "@/app/global-error";
import { fixtureCatalog, fixtureCategories, fixtureProducts } from "../support/catalog-fixture";

// The market locale of the simulated request (the proxy sets it from the path).
const request = vi.hoisted(() => ({ locale: "cs" }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn<(href: string) => void>() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "font-sf" }) }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      host: "shop.test",
      "x-forwarded-proto": "https",
      "x-akros-market-locale": request.locale,
    }),
}));
// The request market follows `request.locale`; everything else of the module is the real one.
vi.mock("@/ontos/active-market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ontos/active-market")>();
  const market = () => ({
    locale: request.locale,
    marketCode: "SHOP",
    currency: request.locale === "cs" ? ("CZK" as const) : ("EUR" as const),
    formatLocale: request.locale,
    configured: true,
  });
  return {
    ...actual,
    getMarketResolution: async () => ({ kind: "live", market: market(), live: [] }),
    getActiveMarket: async () => market(),
    getMoney: async () => ({ currency: market().currency, locale: request.locale }),
    getDictionary: async () => dictionaryFor(request.locale),
  };
});
vi.mock("@/ontos/catalog-server", async () => {
  const { fixtureCatalog } = await import("../support/catalog-fixture");
  return {
    getCatalog: async () => fixtureCatalog,
    getCatalogPage: async () => ({
      model: fixtureCatalog,
      products: [],
      total: 0,
      page: 1,
      pageSize: 0,
    }),
    readProducts: async () => ({ products: [] }),
  };
});
vi.mock("@/ontos/checkout-options", () => ({
  readCheckoutOptions: async () => ({
    shippingMethods: [{ id: "ppl", title: "PPL", priceMinor: 12_900 }],
    paymentAvailable: false,
    carrierTrackingAvailable: false,
  }),
}));
vi.mock("@/ontos/category-branch", () => ({
  CategoryBranch: ({ children }: { children: ReactElement }) => children,
}));

const market = (locale: string): ClientMarket => ({
  locale,
  marketCode: "SHOP",
  currency: locale === "cs" ? "CZK" : "EUR",
  formatLocale: locale,
  configured: true,
  live: [],
});

/**
 * Renders `page` inside the root layout's providers, as the browser receives it. `withoutOntosProducts` drops the
 * product cards (OntOS catalogue data, Czech in the test catalogue) before the markup is returned.
 */
const html = (page: ReactElement, locale = "cs", { withoutOntosProducts = false } = {}) => {
  const { container } = render(
    <BrandProvider brand={toClientBrand(getBrand(), locale)}>
      <MarketProvider market={market(locale)}>
        <CartProvider storage={null}>{page}</CartProvider>
      </MarketProvider>
    </BrandProvider>,
  );
  if (withoutOntosProducts)
    for (const card of container.querySelectorAll('[class*="product-card"]')) card.remove();
  return container.innerHTML;
};

const ontosProductPhoto = /https%3A%2F%2Fwww\.akros\.cz%2Fdata%2Fproduct%2F[\w.]+/g;

/** Editorial pages of the storefront (the ones translated per language). */
const contentPages: [string, () => Promise<ReactElement> | ReactElement][] = [
  ["home", () => HomePage()],
  ["o-nas", () => AboutPage()],
  ["obchodni-podminky", () => TermsPage()],
  ["gdpr", () => PrivacyPage()],
  ["reklamace", () => ClaimsPage()],
  ["partnersky-program", () => PartnerPage()],
  ["faq", () => FaqPage()],
  ["blog", () => BlogPage()],
  ["novinky-a-akce", () => NewsPage()],
  ["doprava-a-platba", () => ShippingPage()],
];

const pages: [string, () => Promise<ReactElement> | ReactElement][] = [
  ...contentPages,
  ["kontakty", () => ContactsPage({ searchParams: Promise.resolve({}) })],
  ["prihlaseni", () => LoginPage()],
  ["404", () => <NotFoundPage />],
];

/** Czech-only letters: a Slovak or English page never shows them (branch and address data excepted). */
const czechOnlyLetters = /[ěřůĚŘŮ]/;
const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
/** OntOS category and product names are catalogue data, not shop copy: they may keep their Czech spelling. */
const ontosNames = [
  ...fixtureCategories.map((category) => category.name),
  ...fixtureProducts.map((product) => product.name),
].filter(Boolean);
const withoutOntosData = (markup: string) =>
  ontosNames.reduce(
    (text, name) => text.split(name).join("").split(escapeHtml(name)).join(""),
    markup,
  );
/** The text around each Czech-only letter outside OntOS data, so a failure names the leftover. */
const czechSnippets = (markup: string) =>
  withoutOntosData(markup).match(new RegExp(`.{0,30}${czechOnlyLetters.source}.{0,20}`, "g")) ?? [];

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
beforeEach(() => {
  request.locale = "cs";
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ŠroubShop brand (STOREFRONT_BRAND=sroubshop)", () => {
  beforeEach(() => vi.stubEnv("STOREFRONT_BRAND", "sroubshop"));

  it.each(["cs", "sk", "en", "pl"])(
    "renders header, sidebar and footer chrome (%s) without AKROS",
    (locale) => {
      const markup = html(
        <>
          <SiteHeader />
          <CatalogSidebar categories={fixtureCatalog.getSidebarCategories()} />
          <SiteFooter />
        </>,
        locale,
      );
      expect(markup).toContain("ŠroubShop");
      expect(markup).toContain("mailto:eshop@sroubarna.demo");
      expect(markup).not.toMatch(/akros/i);
    },
  );

  it.each(pages)("renders the %s page in the shop chrome without AKROS", async (_name, page) => {
    // Product photos are OntOS data (the test catalog still links the original photos); lane P moves them.
    const markup = html(await page()).replaceAll(ontosProductPhoto, "ontos-product-photo");
    expect(markup).toContain("ŠroubShop");
    expect(markup).not.toMatch(/akros/i);
  });

  it.each(["sk", "en"])(
    "renders the content, contacts, login and 404 pages in %s without AKROS or Czech-only letters",
    async (locale) => {
      request.locale = locale;
      for (const [name, page] of pages) {
        const markup = html(await page(), locale, { withoutOntosProducts: true }).replaceAll(
          ontosProductPhoto,
          "ontos-product-photo",
        );
        expect({ name, akros: /akros/i.test(markup) }).toEqual({ name, akros: false });
        expect({ name, czech: czechSnippets(markup) }).toEqual({ name, czech: [] });
      }
    },
  );

  it("answers 404 for the AKROS manufacturing page", async () => {
    await expect(ManufacturingPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await manufacturingMetadata()).toEqual({});
  });

  it("writes the document metadata for the shop", async () => {
    const metadata = await generateMetadata();
    expect(metadata).toMatchObject({
      title: { default: "ŠroubShop | Spojovací a nerezový materiál", template: "%s | ŠroubShop" },
      icons: { icon: { url: "/sroubshop/icon.svg" } },
    });
    expect(JSON.stringify(metadata)).not.toMatch(/akros/i);
  });

  it("names the shop on the market gate and error pages", () => {
    const gate = render(
      <MarketGatePage
        brandName={getBrand().name}
        dictionary={dictionaryFor("sk")}
        kind="unknown"
        live={[]}
      />,
    ).container.innerHTML;
    expect(gate).toContain("ŠroubShop");
    const error = render(<Unavailable reset={() => undefined} storeName="ŠroubShop" />).container
      .innerHTML;
    expect(`${gate}${error}`).not.toMatch(/akros/i);
  });
});

describe("AKROS brand (default)", () => {
  beforeEach(() => vi.stubEnv("STOREFRONT_BRAND", undefined));

  it("keeps the AKROS logo, contacts, production links and metadata", async () => {
    const markup = html(
      <>
        <SiteHeader />
        <CatalogSidebar categories={fixtureCatalog.getSidebarCategories()} />
        <SiteFooter />
      </>,
    );
    expect(markup).toContain("logo-akros.png");
    expect(markup).toContain("akros%2Ffooter%2Flogo.png");
    expect(markup).toContain('href="tel:+420737591849"');
    expect(markup).toContain('href="mailto:akros@akros.cz"');
    // Production is reached from the catalogue sidebar; the utility bar lists informational pages only.
    expect(markup).toContain('href="https://www.akroscz.cz/"');
    expect(markup).toContain("Copyright (c) 2014–2026 AKROS b2c");
    expect(await generateMetadata()).toMatchObject({
      title: { default: "AKROS | Nerezový a spojovací materiál", template: "%s | AKROS" },
      description:
        "E-shop AKROS s nerezovým, hutním a spojovacím materiálem v prezentačním prostředí OntOS.",
    });
  });

  it("keeps the AKROS content pages", async () => {
    expect(html(await AboutPage())).toContain("Společnost AKROS, s.r.o. se specializuje");
    expect(html(await ContactsPage({ searchParams: Promise.resolve({}) }))).toContain(
      "Chřibská 207/41",
    );
    expect(html(await ManufacturingPage())).toContain("AKROS CZ nabízí zakázkovou výrobu");
    expect(html(await TermsPage())).toContain("Zkrácené informace pro prezentační e-shop AKROS.");
    expect(html(await HomePage())).toContain("Vítejte v internetovém obchodě společnosti AKROS");
  });

  it.each(["sk", "en"])(
    "serves the AKROS content in %s, without Czech-only letters",
    async (locale) => {
      request.locale = locale;
      expect(html(await AboutPage(), locale)).toContain("AKROS, s.r.o.");
      expect(html(await TermsPage(), locale)).toContain("AKROS");
      expect(html(await ManufacturingPage(), locale)).toMatch(/AKROS CZ (výroba|manufacturing)/);
      for (const [name, page] of contentPages) {
        const markup = html(await page(), locale, { withoutOntosProducts: true }).replaceAll(
          ontosProductPhoto,
          "ontos-product-photo",
        );
        expect({ name, czech: czechSnippets(markup) }).toEqual({ name, czech: [] });
      }
    },
  );

  it("shows no brand when the root layout itself failed", () => {
    const markup = render(<GlobalError reset={() => undefined} />, {
      container: document.createElement("html"),
    }).container.innerHTML;
    expect(markup).not.toMatch(/akros|šroubshop/i);
  });
});
