import "next/dist/client/app-bootstrap";
import type { ReactElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRouter } from "../support/router";
import { generateMetadata as storefrontMetadata } from "@/app/storefront-metadata";
import { loadLayoutMetadata } from "../support/layout-metadata";

import { CatalogProvider } from "@/ontos/catalog-provider";
import { browserAt, serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";
import { fixtureSnapshot } from "../support/storefront";
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

// The proxy's locale header is real Next request input, not a replacement of next/headers.
const request = { locale: "cs" };
const locales = ["cs", "sk", "en", "pl"];
const seller = { resourceId: "71000000-0000-4000-8000-000000000024" };
const marketId = (locale: string) =>
  `71000000-0000-4000-8000-0000000000${locales.indexOf(locale) + 30}`;
const period = { startsAt: "2020-01-01T00:00:00.000Z" };
const gatewayContext = JSON.stringify({
  apiBaseUrl: "/shell-super-app-api/brand-pages",
  compositionRevision: "a".repeat(64),
  token: "brand-pages-contract",
  expiresAt: 4_000_000_000_000,
});
let network: Awaited<ReturnType<typeof serveHttp>>;

beforeAll(async () => {
  network = await serveHttp(async (incoming) => {
    if (new URL(incoming.url).pathname !== "/shell-super-app-api/auth/api-key/gateway-read")
      return Response.json({ error: "Unexpected endpoint" }, { status: 404 });
    const body = await incoming.json();
    if (body.audience === "commerce-market-catalog") {
      return Response.json(
        {
          markets: locales.map((locale) => ({
            marketRef: { resourceId: marketId(locale) },
            marketCode: `SHOP-${locale}`,
            sellingLegalEntityRef: seller,
            lifecycle: "ACTIVE",
            supportedLocales: [locale],
            effectivePeriod: period,
          })),
          associations: locales.map((locale) => ({
            marketRef: { resourceId: marketId(locale) },
            storefrontRef: { appId: "akros-storefront", tenantId: "brand-pages" },
            sellingLegalEntityRef: seller,
            channel: "B2C",
            effectivePeriod: period,
          })),
        },
        { headers: { "x-ontos-gateway-context": gatewayContext } },
      );
    }
    if (body.audience !== "merchandise")
      return Response.json({ error: "Unexpected audience" }, { status: 400 });
    const locale =
      locales.find((value) => marketId(value) === body.query.view.storefrontCatalog?.marketId) ??
      "cs";
    return Response.json(
      {
        market: {
          marketId: marketId(locale),
          marketCode: `SHOP-${locale}`,
          currency: locale === "cs" ? "CZK" : "EUR",
          configured: true,
        },
        categories: fixtureCategories,
        products: body.query.view.storefrontCatalog?.featured
          ? fixtureCatalog.getHomepageFeaturedProducts().map((product) => ({
              ...product,
              grossPriceMinor: product.priceMinor,
              currentPriceMinor: product.priceMinor,
              currency: locale === "cs" ? "CZK" : "EUR",
              stockOnHand: product.stockCount,
              availability: "IN_STOCK",
            }))
          : [],
        checkout: {
          shippingMethods: [{ id: "ppl", title: "PPL", priceMinor: 12_900 }],
          paymentAvailable: false,
          carrierTrackingAvailable: false,
        },
      },
      { headers: { "x-ontos-gateway-context": gatewayContext } },
    );
  });
});
afterAll(async () => {
  await network.close();
});

async function inRequest<T>(operation: () => T): Promise<Awaited<T>> {
  const context = nextRequest(`https://shop.test/${request.locale}`, {
    headers: {
      host: "shop.test",
      "x-forwarded-proto": "https",
      "x-akros-market-locale": request.locale,
    },
  });
  try {
    return await context.run(operation);
  } finally {
    await context.close();
  }
}
const generateMetadata = () => inRequest(() => storefrontMetadata());

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
    <NextRouter>
      <BrandProvider brand={toClientBrand(getBrand(), locale)}>
        <MarketProvider market={market(locale)}>
          <CatalogProvider snapshot={fixtureSnapshot}>
            <CartProvider storage={null}>{page}</CartProvider>
          </CatalogProvider>
        </MarketProvider>
      </BrandProvider>
    </NextRouter>,
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

beforeEach(() => {
  request.locale = "cs";
  browserAt(network.origin);
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "brand-pages-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", "akros-storefront");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", seller.resourceId);
});
afterEach(async () => {
  cleanup();
  await network.idle();
  vi.unstubAllEnvs();
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
    const markup = html(await inRequest(page)).replaceAll(ontosProductPhoto, "ontos-product-photo");
    expect(markup).toContain("ŠroubShop");
    expect(markup).not.toMatch(/akros/i);
  });

  it.each(["sk", "en"])(
    "renders the content, contacts, login and 404 pages in %s without AKROS or Czech-only letters",
    async (locale) => {
      request.locale = locale;
      for (const [name, page] of pages) {
        const markup = html(await inRequest(page), locale, {
          withoutOntosProducts: true,
        }).replaceAll(ontosProductPhoto, "ontos-product-photo");
        expect({ name, akros: /akros/i.test(markup) }).toEqual({ name, akros: false });
        expect({ name, czech: czechSnippets(markup) }).toEqual({ name, czech: [] });
      }
    },
  );

  it("answers 404 for the AKROS manufacturing page", async () => {
    await expect(inRequest(() => ManufacturingPage())).rejects.toThrow(
      "NEXT_HTTP_ERROR_FALLBACK;404",
    );
    expect(await inRequest(() => manufacturingMetadata())).toEqual({});
  });

  it("writes the document metadata for the shop", async () => {
    const layoutMetadata = await loadLayoutMetadata();
    const metadata = await inRequest(() => layoutMetadata());
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
    expect(html(await inRequest(() => AboutPage()))).toContain(
      "Společnost AKROS, s.r.o. se specializuje",
    );
    expect(
      html(await inRequest(() => ContactsPage({ searchParams: Promise.resolve({}) }))),
    ).toContain("Chřibská 207/41");
    expect(html(await inRequest(() => ManufacturingPage()))).toContain(
      "AKROS CZ nabízí zakázkovou výrobu",
    );
    expect(html(await inRequest(() => TermsPage()))).toContain(
      "Zkrácené informace pro prezentační e-shop AKROS.",
    );
    expect(html(await inRequest(() => HomePage()))).toContain(
      "Vítejte v internetovém obchodě společnosti AKROS",
    );
  });

  it.each(["sk", "en"])(
    "serves the AKROS content in %s, without Czech-only letters",
    async (locale) => {
      request.locale = locale;
      expect(html(await inRequest(() => AboutPage()), locale)).toContain("AKROS, s.r.o.");
      expect(html(await inRequest(() => TermsPage()), locale)).toContain("AKROS");
      expect(html(await inRequest(() => ManufacturingPage()), locale)).toMatch(
        /AKROS CZ (výroba|manufacturing)/,
      );
      for (const [name, page] of contentPages) {
        const markup = html(await inRequest(page), locale, {
          withoutOntosProducts: true,
        }).replaceAll(ontosProductPhoto, "ontos-product-photo");
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
