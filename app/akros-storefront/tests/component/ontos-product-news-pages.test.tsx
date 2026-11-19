// @vitest-environment node
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { within } from "@testing-library/react";
import { Schema } from "effect";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogProduct } from "@/ontos/catalog-types";
import { fixtureCategories, fixtureProducts } from "../support/catalog-fixture";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const product = fixtureProducts.find((candidate) => candidate.detail.variants.length > 1)!;
const sale = fixtureProducts.filter(
  (candidate) => candidate.isSale && candidate.stockCount >= candidate.minimumQuantity,
);

// Serve owner records, not the storefront's already-projected model. Card responses omit variants.
function ownerProduct(input: CatalogProduct, full: boolean) {
  return {
    ...input,
    grossPriceMinor: input.priceMinor,
    currentPriceMinor: input.detail.priceTiers[0]?.priceExcludingVatMinor ?? input.priceMinor,
    stockOnHand: input.stockCount,
    availability: input.stockCount >= input.minimumQuantity ? "IN_STOCK" : "OUT_OF_STOCK",
    variantRecords: full
      ? input.detail.variants.map((variant) => ({
          ...variant,
          name: variant.label,
          grossPriceMinor: variant.priceMinor,
          priceMinor: variant.priceTiers[0]?.priceExcludingVatMinor ?? variant.priceMinor,
          stockOnHand: variant.stockCount,
          availability: variant.stockCount >= variant.minimumQuantity ? "IN_STOCK" : "OUT_OF_STOCK",
        }))
      : [],
    detail: undefined,
    descriptionParagraphs: full ? input.detail.descriptionParagraphs : [],
    parameters: full ? input.detail.parameters : [],
  };
}

const CatalogRead = Schema.Struct({
  storefrontAppId: Schema.Literal("akros-storefront"),
  mode: Schema.optional(Schema.Literal("categories")),
  slug: Schema.optional(Schema.String),
  pageSize: Schema.optional(Schema.Number),
  fields: Schema.optional(Schema.Literals(["card", "full"])),
  label: Schema.optional(Schema.Literals(["new", "action", "sale"])),
  featured: Schema.optional(Schema.Boolean),
  includeCategories: Schema.Boolean,
});
const GatewayRead = Schema.Struct({
  audience: Schema.String,
  readName: Schema.String,
  query: Schema.Unknown,
});
const MerchandiseRead = Schema.Struct({
  view: Schema.Struct({ storefront: Schema.Literal(true), storefrontCatalog: CatalogRead }),
});

let failFlagged = false;
let runtime: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const reads: Array<Schema.Schema.Type<typeof CatalogRead>> = [];
  const network = await serveHttp(async (request) => {
    if (
      new URL(request.url).pathname !== "/shell-super-app-api/auth/api-key/gateway-read" ||
      request.method !== "POST" ||
      request.headers.get("x-api-key") !== "product-news-test-key"
    )
      return new Response("Unexpected gateway request", { status: 404 });
    const body = Schema.decodeUnknownSync(GatewayRead)(await request.json());
    const headers = {
      "x-ontos-gateway-context": JSON.stringify({
        apiBaseUrl: "/shell-super-app-api/product-news",
        token: "product-news-test-assertion",
        compositionRevision: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
      }),
    };
    if (body.audience === "commerce-market-catalog" && body.readName === "current-market-catalog") {
      return Response.json({ markets: [], associations: [] }, { headers });
    }
    if (body.audience !== "merchandise" || body.readName !== "records") {
      return new Response("Unexpected owner read", { status: 404 });
    }
    const query = Schema.decodeUnknownSync(MerchandiseRead, { onExcessProperty: "error" })(
      body.query,
    ).view.storefrontCatalog;
    reads.push(query);
    if (failFlagged && query.label) {
      return Response.json({ code: "flagged_read_failed" }, { status: 400, headers });
    }
    const products = query.slug
      ? [product].filter((candidate) => candidate.slug === query.slug)
      : query.label
        ? sale
        : [];
    return Response.json(
      {
        revision: 1,
        products: products.map((candidate) => ownerProduct(candidate, query.fields === "full")),
        categories: query.includeCategories ? fixtureCategories : [],
        total: products.length,
        page: 1,
        pageSize: query.pageSize ?? products.length,
        homepageFeaturedProductIds: [],
      },
      { headers },
    );
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "product-news-test-key");
  vi.stubEnv("STOREFRONT_BRAND", "akros");
  const request = nextRequest(`${network.origin}/cs`, {
    headers: { "x-akros-market-locale": "cs" },
  });
  const [productPage, newsPage, cart, providers, routerContext, hooksContext, router, adapters] =
    await Promise.all([
      import("@/app/produkt/[slug]/page"),
      import("@/app/novinky-a-akce/page"),
      import("@/features/cart/cart-provider"),
      import("../support/storefront"),
      import("next/dist/shared/lib/app-router-context.shared-runtime"),
      import("next/dist/shared/lib/hooks-client-context.shared-runtime"),
      import("next/router"),
      import("next/dist/shared/lib/router/adapters"),
    ]);
  const { CartProvider } = cart;
  const { StorefrontProviders } = providers;
  const { AppRouterContext } = routerContext;
  const { PathnameContext, SearchParamsContext } = hooksContext;

  const browser = new Window();
  async function renderPage(page: ReactNode, pathname: string) {
    // React's real server stream resolves async pages AND the real async CategoryBranch.
    // No tree-walking, shell replacement, DOM/global writes, hydration or browser interaction claims.
    const stream = await request.run(() =>
      renderToReadableStream(
        <AppRouterContext.Provider value={adapters.adaptForAppRouterInstance(router.default)}>
          <PathnameContext.Provider value={pathname}>
            <SearchParamsContext.Provider value={new URLSearchParams()}>
              <StorefrontProviders>
                <CartProvider storage={null}>{page}</CartProvider>
              </StorefrontProviders>
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </AppRouterContext.Provider>,
      ),
    );
    await stream.allReady;
    const html = await new Response(stream).text();
    const container = new browser.DOMParser().parseFromString(html, "text/html").body;
    await network.idle();
    expect(container).toBeInstanceOf(browser.HTMLElement);
    // happy-dom has separate DOM declarations; the validated native element is query-compatible.
    return { container, screen: within(container as unknown as HTMLElement) };
  }
  return {
    network,
    request,
    reads,
    browser,
    renderPage,
    ProductPage: productPage.default,
    generateMetadata: productPage.generateMetadata,
    NewsPage: newsPage.default,
  };
}

beforeEach(async () => {
  // Each case gets independent real isolate caches, so a previous success cannot hide a failed read.
  vi.resetModules();
  failFlagged = false;
  runtime = await setup();
});
afterEach(async () => {
  try {
    await runtime.request.close();
  } finally {
    await runtime.network.close();
    await runtime.browser.happyDOM.close();
    vi.unstubAllEnvs();
  }
});

describe("OntOS product and news pages", () => {
  it("reads exactly one product by slug from OntOS", async () => {
    const { ProductPage } = runtime;
    const props = {
      params: Promise.resolve({ slug: product.slug }),
      searchParams: Promise.resolve({}),
    };
    const { container, screen } = await runtime.renderPage(
      <ProductPage {...props} />,
      `/produkt/${product.slug}`,
    );
    expect(runtime.reads.filter((query) => query.slug !== undefined)).toEqual([
      {
        slug: product.slug,
        pageSize: 1,
        fields: "full",
        includeCategories: false,
        storefrontAppId: "akros-storefront",
      },
    ]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(product.name);
    expect(await runtime.request.run(() => runtime.generateMetadata(props))).toEqual({
      title: product.name,
    });
    await runtime.network.idle();
    expect(runtime.reads.filter((query) => query.slug !== undefined)).toHaveLength(1);
    expect(container.querySelector(".sf-shell > .sf-header")).not.toBeNull();
    expect(container.querySelector(".sf-sidebar")).not.toBeNull();
  });
  it("reads the new and promotion sections as flagged OntOS card pages", async () => {
    const { NewsPage } = runtime;
    const { container, screen } = await runtime.renderPage(<NewsPage />, "/novinky-a-akce");
    expect(runtime.reads.filter((query) => query.label !== undefined)).toEqual(
      ["new", "action", "sale"].map((label) => ({
        pageSize: 48,
        label,
        fields: "card",
        includeCategories: false,
        storefrontAppId: "akros-storefront",
      })),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Novinky a akce");
    expect(container.querySelectorAll(".sf-catalog-product-card").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Doprodej").length).toBeGreaterThan(0);
    expect(container.querySelector(".sf-shell > .sf-header")).not.toBeNull();
  });
  it("keeps the page up when a flagged read fails", async () => {
    failFlagged = true;
    const { NewsPage } = runtime;
    const { container, screen } = await runtime.renderPage(<NewsPage />, "/novinky-a-akce");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Novinky a akce");
    expect(runtime.reads.some((query) => query.label === "new")).toBe(true);
    expect(runtime.reads.some((query) => query.label === "action")).toBe(true);
    expect(container.querySelector(".sf-shell > .sf-header")).not.toBeNull();
  });
});
