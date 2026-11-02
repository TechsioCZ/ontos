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
import { fixtureCatalog } from "../support/catalog-fixture";

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
  headers: async () => new Headers({ host: "shop.test", "x-forwarded-proto": "https" }),
}));
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

/** Renders `page` inside the root layout's providers, as the browser receives it. */
const html = (page: ReactElement, locale = "cs") =>
  render(
    <BrandProvider brand={toClientBrand(getBrand(), locale)}>
      <MarketProvider market={market(locale)}>
        <CartProvider storage={null}>{page}</CartProvider>
      </MarketProvider>
    </BrandProvider>,
  ).container.innerHTML;

const ontosProductPhoto = /https%3A%2F%2Fwww\.akros\.cz%2Fdata%2Fproduct%2F[\w.]+/g;

const pages: [string, () => Promise<ReactElement> | ReactElement][] = [
  ["home", () => HomePage()],
  ["o-nas", () => AboutPage()],
  ["kontakty", () => ContactsPage({ searchParams: Promise.resolve({}) })],
  ["obchodni-podminky", () => TermsPage()],
  ["gdpr", () => PrivacyPage()],
  ["reklamace", () => ClaimsPage()],
  ["partnersky-program", () => PartnerPage()],
  ["faq", () => FaqPage()],
  ["blog", () => BlogPage()],
  ["novinky-a-akce", () => NewsPage()],
  ["prihlaseni", () => LoginPage()],
  ["doprava-a-platba", () => ShippingPage()],
  ["404", () => <NotFoundPage />],
];

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
beforeEach(() => {
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

  it("answers 404 for the AKROS manufacturing page", () => {
    expect(() => ManufacturingPage()).toThrow("NEXT_NOT_FOUND");
    expect(manufacturingMetadata()).toEqual({});
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
    expect(markup).toContain('href="/cs/kategorie/akroscz-vyroba"');
    expect(markup).toContain('href="https://www.akroscz.cz/"');
    expect(markup).toContain("Copyright (c) 2014–2026 AKROS b2c");
    expect(await generateMetadata()).toMatchObject({
      title: { default: "AKROS | Nerezový a spojovací materiál", template: "%s | AKROS" },
      description:
        "E-shop AKROS s nerezovým, hutním a spojovacím materiálem v prezentačním prostředí OntOS.",
    });
  });

  it("keeps the AKROS content pages", async () => {
    expect(html(AboutPage())).toContain("Společnost AKROS, s.r.o. se specializuje");
    expect(html(await ContactsPage({ searchParams: Promise.resolve({}) }))).toContain(
      "Chřibská 207/41",
    );
    expect(html(ManufacturingPage())).toContain("AKROS CZ nabízí zakázkovou výrobu");
    expect(html(TermsPage())).toContain("Zkrácené informace pro prezentační e-shop AKROS.");
    expect(html(await HomePage())).toContain("Vítejte v internetovém obchodě společnosti AKROS");
  });

  it("shows no brand when the root layout itself failed", () => {
    const markup = render(<GlobalError reset={() => undefined} />, {
      container: document.createElement("html"),
    }).container.innerHTML;
    expect(markup).not.toMatch(/akros|šroubshop/i);
  });
});
