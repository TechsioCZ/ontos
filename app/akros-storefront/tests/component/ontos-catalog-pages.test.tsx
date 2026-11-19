// @vitest-environment node
import { Window, type Element } from "happy-dom";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.node";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { adaptForAppRouterInstance } from "next/dist/shared/lib/router/adapters";
import singletonRouter from "next/router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CategoryPage from "@/app/kategorie/[slug]/page";
import SearchPage from "@/app/vyhledavani/page";
import { CartProvider } from "@/features/cart/cart-provider";
import type { CatalogQuery } from "@/ontos/catalog-server";
import type { CatalogProduct, CatalogProductVariant } from "@/ontos/catalog-types";
import {
  fixtureCatalog,
  fixtureCategories,
  fixtureCategoryProducts,
} from "../support/catalog-fixture";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";
import { StorefrontProviders } from "../support/storefront";

/** Owner wire data, deliberately passed through the real catalog projection and loaders. */
const ownerOffer = (variant: CatalogProductVariant) => ({
  id: variant.id,
  name: variant.label,
  sku: variant.sku,
  imageSrc: variant.imageSrc,
  currency: "CZK",
  grossPriceMinor: variant.priceMinor,
  priceMinor:
    variant.priceTiers.find((tier) => tier.priceMinor === variant.priceMinor)
      ?.priceExcludingVatMinor ?? variant.priceMinor,
  availability: "IN_STOCK",
  stockOnHand: variant.stockCount,
  minimumQuantity: variant.minimumQuantity,
  packageQuantity: variant.packageQuantity,
  unit: variant.unit,
});
const ownerProduct = (product: CatalogProduct) => ({
  id: product.id,
  slug: product.slug,
  name: product.name,
  sku: product.sku,
  categoryId: product.categoryId,
  currency: product.currency,
  unit: product.unit,
  imageSrc: product.imageSrc,
  imageAlt: product.imageAlt,
  grossPriceMinor: product.priceMinor,
  currentPriceMinor: product.priceMinor,
  availability: "IN_STOCK",
  stockOnHand: product.stockCount,
  variantSummary: product.variantSummary,
});
const categoryProducts = fixtureCategoryProducts("srouby").slice(0, 3);
const listingPage = (total: number) => ({
  products: categoryProducts.map(ownerProduct),
  total,
  page: 2,
  pageSize: 24,
  revision: 1,
  homepageFeaturedProductIds: [],
});

type OwnerQuery = CatalogQuery & {
  mode?: string;
  fields?: string;
  includeCategories?: boolean;
  includeCategoryContent?: boolean;
};
let answerListing: (query: OwnerQuery) => ReturnType<typeof listingPage>;
let network: Awaited<ReturnType<typeof serveHttp>>;
let request: ReturnType<typeof nextRequest>;
const listingQueries: OwnerQuery[] = [];
const browsers: Window[] = [];

beforeEach(async () => {
  listingQueries.length = 0;
  answerListing = () => listingPage(100);
  network = await serveHttp(async (incoming) => {
    expect(new URL(incoming.url).pathname).toBe("/shell-super-app-api/auth/api-key/gateway-read");
    expect(incoming.headers.get("x-api-key")).toBe("catalog-pages-test-key");
    const body: { audience: string; query: { view?: { storefrontCatalog?: OwnerQuery } } } =
      await incoming.json();
    let result: unknown;
    if (body.audience === "commerce-market-catalog") {
      result = { markets: [], associations: [] };
    } else {
      expect(body.audience).toBe("merchandise");
      const query = body.query.view?.storefrontCatalog;
      if (!query) throw new Error("Missing storefront catalog query");
      if (query.mode === "categories") result = { categories: fixtureCategories };
      else if (query.includeCategoryContent)
        result = { ...listingPage(100), categories: fixtureCategories };
      else if (query.featured) result = { ...listingPage(0), products: [] };
      else {
        listingQueries.push(query);
        result = answerListing(query);
      }
    }
    return Response.json(result, {
      headers: {
        "x-ontos-gateway-context": JSON.stringify({
          apiBaseUrl: "/shell-super-app-api/merchandise",
          token: "catalog-pages-token",
          compositionRevision: "a".repeat(64),
          expiresAt: Date.now() + 60_000,
        }),
      },
    });
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "catalog-pages-test-key");
  request = nextRequest(`${network.origin}/cs`, { headers: { "x-akros-market-locale": "cs" } });
});
afterEach(async () => {
  try {
    await request.close();
  } finally {
    await network.close();
    vi.unstubAllEnvs();
    await Promise.all(browsers.splice(0).map((browser) => browser.happyDOM.close()));
  }
});

/** React's public server renderer awaits the real async page and its async children. */
async function renderPage(page: () => Promise<ReactNode>) {
  return request.run(async () => {
    const content = await page();
    const errors: unknown[] = [];
    const stream = await renderToReadableStream(
      <AppRouterContext.Provider value={adaptForAppRouterInstance(singletonRouter)}>
        <StorefrontProviders>
          <CartProvider storage={null}>{content}</CartProvider>
        </StorefrontProviders>
      </AppRouterContext.Provider>,
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    await stream.allReady;
    const html = await new Response(stream).text();
    if (errors.length) throw new AggregateError(errors, "Catalog server render failed");
    await network.idle();
    const browser = new Window();
    browsers.push(browser);
    return new browser.DOMParser().parseFromString(html, "text/html");
  });
}

describe("OntOS category and search pages", () => {
  it("lets OntOS filter, sort and page the category and shows its total", async () => {
    const document = await renderPage(() =>
      CategoryPage({
        params: Promise.resolve({ slug: "srouby" }),
        searchParams: Promise.resolve({
          page: "2",
          sort: "price-asc",
          min: "10",
          availability: "in-stock",
        }),
      }),
    );
    expect(listingQueries).toContainEqual({
      categorySlug: "srouby",
      page: 2,
      pageSize: 24,
      sort: "price-asc",
      minMinor: 1000,
      availability: "in-stock",
      fields: "card",
      includeCategories: false,
      storefrontAppId: "akros-storefront",
    });
    expect(document.querySelector("h1")?.textContent).toBe("Šrouby");
    expect(document.querySelectorAll(".sf-catalog-product-card").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector('form[aria-label="Filtrování produktů"]')?.textContent).toContain(
      "100",
    );
  });
  it("re-reads the last page when the requested page is past the end", async () => {
    answerListing = (query) => ({
      ...listingPage(30),
      products: query.page === 9 ? [] : categoryProducts.map(ownerProduct),
    });
    await renderPage(() =>
      CategoryPage({
        params: Promise.resolve({ slug: "srouby" }),
        searchParams: Promise.resolve({ page: "9" }),
      }),
    );
    expect(listingQueries[1]).toMatchObject({ categorySlug: "srouby", page: 2 });
  });
  it("shows the Czech filter hint when OntOS finds nothing for active filters", async () => {
    answerListing = () => ({ ...listingPage(0), products: [] });
    const document = await renderPage(() =>
      CategoryPage({
        params: Promise.resolve({ slug: "srouby" }),
        searchParams: Promise.resolve({ q: "neexistuje" }),
      }),
    );
    expect(document.querySelector(".sf-empty-state")?.textContent).toBe(
      "Nenalezeny žádné produkty. Upravte nebo vymažte filtry.",
    );
  });
  it("searches through OntOS and skips the read for an empty query", async () => {
    answerListing = () => ({
      ...listingPage(100),
      products: categoryProducts.map((product) => ({
        ...ownerProduct(product),
        searchMatch: {
          kind: "product",
          ...(product.variantSummary.count === 1
            ? {
                onlyVariant: ownerOffer(
                  product.detail.variants.find((item) => item.priceMinor > 0)!,
                ),
              }
            : {}),
        },
      })),
    });
    const document = await renderPage(() =>
      SearchPage({ searchParams: Promise.resolve({ q: " šroub ", page: "2" }) }),
    );
    expect(listingQueries).toContainEqual({
      q: "šroub",
      page: 2,
      pageSize: 24,
      fields: "card",
      includeCategories: false,
      storefrontAppId: "akros-storefront",
    });
    expect(document.querySelectorAll(".sf-catalog-product-card").length).toBeGreaterThanOrEqual(3);
    const readsBeforeEmpty = network.requests.length;
    const queriesBeforeEmpty = listingQueries.length;
    await renderPage(() => SearchPage({ searchParams: Promise.resolve({ q: "  " }) }));
    expect(listingQueries).toHaveLength(queriesBeforeEmpty);
    expect(network.requests).toHaveLength(readsBeforeEmpty);
  });
  it("routes search hits to the exact variant or to the query-filtered variant table", async () => {
    const exact = fixtureCatalog.getProductBySlug(
      "matice-nytovaci-se-zapustnou-hlavou-an-1972-a2",
    )!;
    const shared = fixtureCatalog.getProductBySlug("dvojniply-typ-310-mat-1-4404")!;
    const variant = exact.detail.variants.find((item) => item.id === "item-9025")!;
    const cards: Element[] = [];
    for (const [query, product, searchMatch] of [
      ["10197200040300", exact, { kind: "single", variant: ownerOffer(variant) }],
      ["3dn31028000000025", shared, { kind: "multiple", count: 2 }],
    ] as const) {
      answerListing = () => ({
        ...listingPage(1),
        products: [{ ...ownerProduct(product), searchMatch }],
        page: 1,
      });
      const document = await renderPage(() =>
        SearchPage({ searchParams: Promise.resolve({ q: query }) }),
      );
      cards.push(...document.querySelectorAll("article"));
    }
    const [exactCard, sharedCard] = cards;
    expect(exactCard.querySelector("a")?.getAttribute("href")).toBe(
      `/cs/produkt/${exact.slug}?variantIds=item-9025#product-variants`,
    );
    expect(exactCard.textContent).toContain(`Varianta: ${variant.label} · SKU ${variant.sku}`);
    expect(exactCard.querySelector("[data-sf-product-price]")?.textContent).not.toContain(
      "Cena dle varianty",
    );
    expect(sharedCard.querySelector("a")?.getAttribute("href")).toBe(
      `/cs/produkt/${shared.slug}?variant=3dn31028000000025#product-variants`,
    );
    expect(sharedCard.textContent).toContain("2 odpovídajících variant");
    expect(sharedCard.querySelector("[data-sf-product-price]")?.textContent).toBe(
      "Cena dle varianty",
    );
  });
});
