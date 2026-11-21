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
      lifecycle: "DRAFT",
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
        lifecycle: "WORK_IN_PROGRESS",
        // Symmy may import a Variant without SKU: its SKU cell stays empty.
        ...(n === 3 ? {} : { sku: `ERP-${n}` }),
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
      priceGroupSelector: { kind: "NO_GROUP" },
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
  /** What Commerce's portal answers the signed-in customer's page price call, and what it was asked. */
  const portal = {
    answer: (): Response => new Response("Unexpected portal request", { status: 404 }),
    calls: [] as { cookie: string | null; body: unknown }[],
  };
  const network = await serveHttp(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/shell-super-app-api/auth/api-key/gateway-context")
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/owner",
        token: "portal-test-assertion",
        compositionRevision: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
      });
    if (path === "/shell-super-app-api/owner/api/portal-auth/catalog-page-prices") {
      portal.calls.push({ cookie: request.headers.get("cookie"), body: await request.json() });
      return portal.answer();
    }
    if (path !== "/shell-super-app-api/auth/api-key/gateway-read")
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
  vi.stubEnv("ONTOS_STOREFRONT_ERP_OFFERS", JSON.stringify({ [legalEntityId]: offer }));
  vi.stubEnv("STOREFRONT_BRAND", "akros");
  // A real storefront request always carries its host: the portal origin is derived from it.
  const request = nextRequest(`${network.origin}/cs`, {
    headers: { host: new URL(network.origin).host, "x-akros-market-locale": "cs" },
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
  async function renderPage(page: ReactNode, pathname: string, context = request) {
    const stream = await context.run(() =>
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
    portal,
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

/** The same storefront request, carrying a portal session cookie beside an unrelated one. */
const signedInRequest = () =>
  nextRequest(`${runtime.network.origin}/cs`, {
    headers: {
      cookie: "theme=dark; commerce-portal.session_token=customer",
      host: new URL(runtime.network.origin).host,
      "x-akros-market-locale": "cs",
    },
  });
const variantRows = (container: { querySelectorAll: (selector: string) => Iterable<Element> }) =>
  [...container.querySelectorAll("[data-sf-erp-variant]")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()),
  );

describe("ERP product pages", () => {
  it("is off when the offers name no entry for this storefront's company", async () => {
    vi.stubEnv(
      "ONTOS_STOREFRONT_ERP_OFFERS",
      JSON.stringify({ "71000000-0000-4000-8000-000000000024": offer }),
    );
    const { Listing } = runtime;
    await expect(Promise.resolve().then(() => Listing())).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect(ownerReads()).toEqual([]);
  });

  it("lists the imported products from Catalog with their ERP price and stock", async () => {
    const { Listing } = runtime;
    const { container, screen } = await runtime.renderPage(<Listing />, "/novinky-z-erp");
    expect(ownerReads()).toEqual([
      {
        audience: "catalog",
        readName: "product-page",
        query: { lifecycles: ["DRAFT", "ACTIVE"], locale: "cs", limit: 48, offset: 0 },
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
      ["M3", "", "M3", "Cena na dotaz", "Dostupnost ověřujeme"],
    ]);
    expect(container.textContent).toContain("Dovezeno ze Symmy.");
    expect(container.textContent).toContain("Objednání této položky připravujeme.");
    expect(container.querySelector(".sf-product-detail__image")?.getAttribute("src")).toContain(
      "image-unavailable.svg",
    );
    expect(screen.queryByRole("button", { name: /košík/iu })).toBeNull();
  });
});

describe("ERP product pages for a signed-in customer", () => {
  it("prices the page through Commerce's portal with the customer's own Price Group", async () => {
    runtime.portal.answer = () =>
      Response.json({
        ...prices,
        prices: [
          {
            ...prices.prices[0],
            priceGroupSelector: { kind: "PRICE_GROUP" },
            priceRevision: { monetaryAmount: { amount: "2.25", currencyCode: "CZK" } },
          },
          ...prices.prices.slice(1),
        ],
      });
    const signedIn = signedInRequest();
    try {
      const { Detail } = runtime;
      const { container } = await runtime.renderPage(
        <Detail params={Promise.resolve({ productId })} />,
        `/novinky-z-erp/${productId}`,
        signedIn,
      );
      expect(runtime.portal.calls).toHaveLength(1);
      expect(runtime.portal.calls[0]?.cookie).toBe("commerce-portal.session_token=customer");
      expect(ownerReads().map(({ audience }) => audience)).toEqual(["catalog", "inventory"]);
      expect(variantRows(container)[0]?.[3]).toContain("2,25\u00a0Kč bez DPH");
      expect(container.textContent).toContain("Vaše cena");
    } finally {
      await signedIn.close();
    }
  });

  it.each([
    [
      "the portal is unavailable",
      () => Response.json({ code: "authentication_unavailable" }, { status: 503 }),
    ],
    ["the portal answers an internal error", () => new Response("boom", { status: 500 })],
    [
      "the session is not admitted",
      () => Response.json({ code: "account_disabled" }, { status: 403 }),
    ],
    ["the portal answers no JSON", () => new Response("not json", { status: 200 })],
  ])("prices the page as a guest when %s", async (_case, answer) => {
    runtime.portal.answer = answer;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const signedIn = signedInRequest();
    try {
      const { Detail } = runtime;
      const { container } = await runtime.renderPage(
        <Detail params={Promise.resolve({ productId })} />,
        `/novinky-z-erp/${productId}`,
        signedIn,
      );
      expect(runtime.portal.calls).toHaveLength(1);
      expect(ownerReads().map(({ audience }) => audience)).toEqual([
        "catalog",
        "inventory",
        "pricing",
      ]);
      expect(variantRows(container)[0]?.[3]).toBe("249,90\u00a0Kč bez DPH");
      expect(container.textContent).not.toContain("Vaše cena");
    } finally {
      errors.mockRestore();
      await signedIn.close();
    }
  });
});
