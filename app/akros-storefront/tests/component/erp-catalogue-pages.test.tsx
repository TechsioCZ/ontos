// @vitest-environment node
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { within } from "@testing-library/react";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const tenantId = "bceaa540-13eb-5508-9ac0-9ed7e40a2ee9";
const legalEntityId = "c0c78a3e-6e2a-57e0-9d0d-86253499fee7";
const offer = {
  customerConfigurationId: "akros-eshop",
  channelId: "B2C",
  marketId: "akros-cz",
  currencyCode: "CZK",
  unitId: "30000000-0000-4000-8000-000000000001",
  unitQuantity: "1",
};
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: "commerce.catalog",
  resourceType,
  resourceId,
  tenantId,
});
const productId = "10000000-0000-4000-8000-000000000001";
const productRef = ref("commerce.catalog.product", productId);
const variantRef = (n: number) =>
  ref("commerce.catalog.variant", `20000000-0000-4000-8000-00000000000${n}`);
const catalogPage = {
  count: 1,
  items: [
    {
      productRef,
      lifecycle: "ACTIVE",
      revision: 1,
      localized: {
        kind: "PRESENT",
        locale: "cs",
        name: "Šroub z ERP",
        description: "Dovezeno ze Symmy.",
      },
      categories: [],
      media: [],
      variants: [1, 2, 3].map((n) => ({
        variantRef: variantRef(n),
        lifecycle: "ACTIVE",
        sku: `ERP-${n}`,
        localized: { kind: "MISSING_TRANSLATION", requestedLocale: "cs" },
        options: [{ values: [{ kind: "TEXT", text: `M${n}` }] }],
      })),
    },
  ],
};
const onHand = {
  items: [
    { outcome: "ON_HAND", variantRef: variantRef(1), total: { amount: "42" } },
    { outcome: "ON_HAND", variantRef: variantRef(2), total: { amount: "0" } },
    { outcome: "NO_STOCK_ITEM", variantRef: variantRef(3) },
  ],
};
const prices = {
  _tag: "CATALOG_PAGE_PRICED",
  prices: [
    {
      _tag: "PRICE_FOUND",
      catalogSelection: { productRef, variantRef: variantRef(1) },
      priceRevision: { monetaryAmount: { amount: "249.9", currencyCode: "CZK" } },
    },
    { _tag: "NO_APPLICABLE_PRICE", catalogSelection: { productRef, variantRef: variantRef(2) } },
    { _tag: "NO_APPLICABLE_PRICE", catalogSelection: { productRef, variantRef: variantRef(3) } },
  ],
};

type GatewayRead = {
  audience: string;
  readName: string;
  legalEntityId?: string;
  query: Record<string, unknown>;
};
let runtime: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const reads: GatewayRead[] = [];
  const network = await serveHttp(async (request) => {
    if (new URL(request.url).pathname !== "/shell-super-app-api/auth/api-key/gateway-read")
      return new Response("Unexpected gateway request", { status: 404 });
    const body = (await request.json()) as GatewayRead;
    reads.push(body);
    const headers = {
      "x-ontos-gateway-context": JSON.stringify({
        apiBaseUrl: "/shell-super-app-api/erp",
        token: "erp-test-assertion",
        compositionRevision: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
      }),
    };
    const answer =
      body.audience === "commerce-market-catalog"
        ? { markets: [], associations: [] }
        : body.audience === "catalog" && body.readName === "product-page"
          ? catalogPage
          : body.audience === "inventory" && body.readName === "catalog-variant-on-hand-page"
            ? { backend: {}, customerConfigurationId: offer.customerConfigurationId, ...onHand }
            : body.audience === "pricing" && body.readName === "catalog-page-prices"
              ? prices
              : undefined;
    return answer === undefined
      ? new Response("Unexpected owner read", { status: 404 })
      : Response.json(answer, { headers });
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "erp-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  vi.stubEnv("ONTOS_STOREFRONT_ERP_OFFER", JSON.stringify(offer));
  vi.stubEnv("STOREFRONT_BRAND", "akros");
  const request = nextRequest(`${network.origin}/cs`, {
    headers: { "x-akros-market-locale": "cs" },
  });
  const [listing, detail, cart, providers, routerContext, hooksContext, router, adapters] =
    await Promise.all([
      import("@/app/novinky-z-erp/page"),
      import("@/app/novinky-z-erp/[productId]/page"),
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
    return { container, screen: within(container as unknown as HTMLElement) };
  }
  return {
    network,
    request,
    reads,
    browser,
    renderPage,
    Listing: listing.default,
    Detail: detail.default,
  };
}

beforeEach(async () => {
  vi.resetModules();
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

const ownerReads = () =>
  runtime.reads.filter(({ audience }) => audience !== "commerce-market-catalog");

describe("ERP product pages", () => {
  it("lists the imported products from Catalog with their ERP price and stock", async () => {
    const { Listing } = runtime;
    const { container, screen } = await runtime.renderPage(<Listing />, "/novinky-z-erp");
    expect(ownerReads()).toEqual([
      {
        audience: "catalog",
        readName: "product-page",
        query: { lifecycles: ["ACTIVE"], locale: "cs", limit: 48, offset: 0 },
      },
      {
        audience: "inventory",
        legalEntityId,
        readName: "catalog-variant-on-hand-page",
        query: {
          customerConfigurationId: offer.customerConfigurationId,
          variantRefs: [1, 2, 3].map(variantRef),
        },
      },
      {
        audience: "pricing",
        legalEntityId,
        readName: "catalog-page-prices",
        query: {
          channelId: "B2C",
          currencyCode: "CZK",
          marketId: "akros-cz",
          items: [1, 2, 3].map((n) => ({
            catalogSelection: { productRef, variantRef: variantRef(n) },
            unitBasis: {
              quantity: "1",
              unitRef: {
                moduleId: "commerce.catalog",
                resourceId: offer.unitId,
                resourceType: "commerce.catalog.product-unit",
                tenantId,
              },
            },
          })),
        },
      },
    ]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Novinky z ERP");
    const card = container.querySelector("[data-sf-erp-products] article")!;
    console.log("[listing card]", card.textContent);
    expect(card.textContent).toContain("Šroub z ERP");
    expect(card.textContent).toContain("od 249,90\u00a0Kč bez DPH");
    expect(card.textContent).toContain("Skladem");
    expect(card.textContent).toContain("Objednání této položky připravujeme.");
    expect(card.querySelector("img")?.getAttribute("src")).toContain("image-unavailable.svg");
    expect(card.querySelector("a")?.getAttribute("href")).toBe(`/cs/novinky-z-erp/${productId}`);
    expect(container.querySelector(".sf-shell > .sf-header")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /košík/iu })).toBeNull();
  });

  it("shows one imported product with each variant's SKU, options, ERP price and ERP stock", async () => {
    const { Detail } = runtime;
    const { container, screen } = await runtime.renderPage(
      <Detail params={Promise.resolve({ productId })} />,
      `/novinky-z-erp/${productId}`,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Šroub z ERP");
    const rows = [...container.querySelectorAll("[data-sf-erp-variant]")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()),
    );
    console.log("[detail rows]", JSON.stringify(rows));
    expect(rows).toEqual([
      ["M1", "ERP-1", "M1", "249,90\u00a0Kč bez DPH", "Skladem: 42 ks"],
      ["M2", "ERP-2", "M2", "Cena na dotaz", "Není skladem"],
      ["M3", "ERP-3", "M3", "Cena na dotaz", "Dostupnost ověřujeme"],
    ]);
    expect(container.textContent).toContain("Dovezeno ze Symmy.");
    expect(container.textContent).toContain("Objednání této položky připravujeme.");
    expect(container.querySelector(".sf-product-detail__image")?.getAttribute("src")).toContain(
      "image-unavailable.svg",
    );
    expect(screen.queryByRole("button", { name: /košík/iu })).toBeNull();
  });
});
