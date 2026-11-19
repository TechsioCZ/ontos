// @vitest-environment node
import { within } from "@testing-library/react";
import { Window } from "happy-dom";
import { Schema } from "effect";
import { renderToReadableStream } from "react-dom/server.node";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import singletonRouter from "next/router";
import { adaptForAppRouterInstance } from "next/dist/shared/lib/router/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProductPage from "@/app/produkt/[slug]/page";
import { akros } from "@/brand/akros";
import { toClientBrand } from "@/brand";
import { BrandProvider } from "@/brand/brand-context";
import { CartProvider } from "@/features/cart/cart-provider";
import { CatalogProvider } from "@/ontos/catalog-provider";
import { MarketProvider } from "@/ontos/market-context";
import type { CatalogProduct } from "@/ontos/catalog-types";
import { fixtureCatalog, fixtureProducts } from "../support/catalog-fixture";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";
import { unmarketedMarket } from "../support/market-fixture";

const withVariants = fixtureProducts.find(
  (candidate) =>
    candidate.detail.variants.length > 2 &&
    candidate.detail.variants.every((variant) => variant.priceMinor > 0),
)!;
const plain: CatalogProduct = {
  ...fixtureProducts.find(
    (candidate) => candidate.detail.variants.length === 0 && candidate.priceMinor > 0,
  )!,
  // Weight is projected from the source-feed SKU index, not an owner netWeight field.
  sku: "100084a0040035",
  unit: "ks",
  netWeight: 0.0034,
};
const products = [withVariants, plain];
const categories = [
  ...new Map(
    products.flatMap((product) => {
      const category = fixtureCatalog.getCategoryById(product.categoryId);
      return category
        ? fixtureCatalog.getCategoryTrail(category).map((node) => [node.id, node] as const)
        : [];
    }),
  ).values(),
];

// Serve the owner's wire shape: production projection must recover every rendered variant and price.
const ownerProduct = (product: CatalogProduct) => ({
  ...product,
  currentPriceMinor: product.detail.priceTiers[0]?.priceExcludingVatMinor ?? product.priceMinor,
  grossPriceMinor: product.priceMinor,
  availability: "IN_STOCK",
  stockTracked: true,
  stockOnHand: product.stockCount,
  parameters: product.detail.parameters,
  variantRecords: product.detail.variants.map((variant) => ({
    ...variant,
    name: variant.label,
    grossPriceMinor: variant.priceMinor,
    priceMinor: variant.priceTiers[0]?.priceExcludingVatMinor ?? variant.priceMinor,
    availability: "IN_STOCK",
    stockOnHand: variant.stockCount,
  })),
});

const gatewayRead = Schema.Struct({ audience: Schema.String, query: Schema.Unknown });
const catalogRead = Schema.Struct({
  view: Schema.Struct({
    storefront: Schema.Literal(true),
    storefrontCatalog: Schema.Struct({
      mode: Schema.optional(Schema.String),
      featured: Schema.optional(Schema.Boolean),
      slug: Schema.optional(Schema.String),
    }),
  }),
});

let network: Awaited<ReturnType<typeof serveHttp>>;
let browser: Window | undefined;
let screen: ReturnType<typeof within>;
// The parser belongs to a separate happy-dom realm, not the Node test globals.
const isRenderedElement = (value: unknown): value is HTMLElement =>
  browser !== undefined &&
  typeof value === "object" &&
  value !== null &&
  browser.HTMLElement.prototype.isPrototypeOf(value);
const cleanup = () => {
  browser?.close();
  browser = undefined;
};
beforeEach(async () => {
  network = await serveHttp(async (request) => {
    if (new URL(request.url).pathname !== "/shell-super-app-api/auth/api-key/gateway-read") {
      return new Response("Unexpected endpoint", { status: 404 });
    }
    const { audience, query } = Schema.decodeUnknownSync(gatewayRead)(await request.json());
    const headers = {
      "x-ontos-gateway-context": JSON.stringify({
        apiBaseUrl: "/shell-super-app-api/merchandise",
        compositionRevision: "a".repeat(64),
        token: "product-detail-test-assertion",
        expiresAt: Date.now() + 60_000,
      }),
    };
    if (audience === "commerce-market-catalog") {
      return Response.json({ markets: [], associations: [] }, { headers });
    }
    if (audience !== "merchandise") return new Response("Unexpected audience", { status: 400 });
    const catalog = Schema.decodeUnknownSync(catalogRead)(query).view.storefrontCatalog;
    const selected =
      catalog.mode === "categories" || catalog.featured
        ? []
        : products.filter((product) => product.slug === catalog.slug).map(ownerProduct);
    return Response.json(
      {
        products: selected,
        categories,
        homepageFeaturedProductIds: [],
        total: selected.length,
        page: 1,
        pageSize: 1,
      },
      { headers },
    );
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "product-detail-test-key");
  vi.stubEnv("STOREFRONT_BRAND", "akros");
});
afterEach(async () => {
  cleanup();
  try {
    await network.idle();
    await network.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

const renderPage = async (
  product: CatalogProduct,
  searchParams: { variant?: string; variantIds?: string } = {},
) => {
  const pathname = `/produkt/${product.slug}`;
  const request = nextRequest(`${network.origin}/cs${pathname}`, {
    headers: { "x-akros-market-locale": "cs", "x-akros-store-path": pathname },
  });
  const errors: unknown[] = [];
  try {
    // React's server stream resolves the async page AND the real async CategoryBranch.
    // These cases guard server-rendered content, not hydration or purchase interactions.
    const html = await request.run(async () => {
      const stream = await renderToReadableStream(
        <AppRouterContext.Provider value={adaptForAppRouterInstance(singletonRouter)}>
          <PathnameContext.Provider value={`/cs${pathname}`}>
            <SearchParamsContext.Provider value={new URLSearchParams(searchParams)}>
              <MarketProvider market={{ ...unmarketedMarket, live: [] }}>
                <BrandProvider brand={toClientBrand(akros, "cs")}>
                  <CatalogProvider
                    snapshot={{
                      catalog: { products: [], homepageFeaturedProductIds: [] },
                      categories: {
                        categories: categories.filter((category) => !category.parentId),
                      },
                    }}
                  >
                    <CartProvider storage={null}>
                      <ProductPage
                        params={Promise.resolve({ slug: product.slug })}
                        searchParams={Promise.resolve(searchParams)}
                      />
                    </CartProvider>
                  </CatalogProvider>
                </BrandProvider>
              </MarketProvider>
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </AppRouterContext.Provider>,
        {
          onError: (error) => {
            errors.push(error);
          },
        },
      );
      await stream.allReady;
      return await new Response(stream).text();
    });
    if (errors.length) throw new AggregateError(errors, "Product server render failed");
    browser = new Window({ url: `${network.origin}/cs${pathname}` });
    const document = new browser.DOMParser().parseFromString(html, "text/html");
    const container: unknown = document.body;
    if (!isRenderedElement(container)) throw new Error("Server HTML has no body element");
    screen = within(container);
    return { container };
  } finally {
    await request.close();
  }
};

describe("product detail page", () => {
  it("exposes every owner variant for purchase", async () => {
    const { container } = await renderPage(withVariants);
    const main = container.querySelector("main")!;
    expect(main.querySelector("h1#product-title")?.textContent).toBe(withVariants.name);
    expect(main.querySelector("#product-variants .sf-variant-table__order")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /^Koupit/ }).length).toBeGreaterThan(0);
    const table = screen.getByRole("table", { name: "Varianty produktu" });
    expect(within(table).getAllByRole("row")).toHaveLength(withVariants.detail.variants.length + 1);
    expect(screen.getByRole("heading", { name: "Doprava a platba" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Více o dopravě a platbě" }).getAttribute("href")).toBe(
      "/cs/doprava-a-platba",
    );
  });

  it("narrows the table to a shared variant selection and reports a vanished one", async () => {
    const [first] = withVariants.detail.variants;
    await renderPage(withVariants, { variantIds: `${first.id},gone` });
    const table = screen.getByRole("table", { name: "Varianty produktu" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(
      screen.getByText(/Sdílený výběr: 1 variant\. Část sdílených variant již není v katalogu\./),
    ).toBeTruthy();
    cleanup();
    await renderPage(withVariants, { variantIds: "gone" });
    expect(screen.getByText("Sdílené varianty již nejsou v katalogu.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Varianty produktu" })).toBeNull();
  });

  it("shows the source weight and the purchase form of a product without variants", async () => {
    const { container } = await renderPage(plain);
    expect(screen.getByText("Hmotnost")).toBeTruthy();
    expect(screen.getByText("0,0034 kg")).toBeTruthy();
    expect(container.querySelector("main .sf-purchase-form")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Koupit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: `Uložit ${plain.name} do oblíbených` })).toBeTruthy();
  });

  it("hides the purchase of a product without variants behind a vanished shared selection", async () => {
    const { container } = await renderPage(plain, { variantIds: "gone" });
    expect(screen.getByText("Sdílené varianty již nejsou v katalogu.")).toBeTruthy();
    expect(container.querySelector(".sf-product-detail .sf-purchase-form")).toBeNull();
  });
});
