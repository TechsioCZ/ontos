import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalog } from "@/ontos/catalog-model";
import { projectProducts } from "@/ontos/catalog-projection";
import { getCatalogPage, readProducts, type CatalogPage } from "@/ontos/catalog-server";
import { dynamic, fetchCache, POST } from "@/app/api/ontos/search/route";
import { toSearchGridItem, type RemoteSearchResponse } from "@/ontos/search-suggestions";
import { readSearchVariantMatches } from "@/ontos/search-variants";
import { cs } from "@/i18n/cs";

const { renderCache } = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { renderCache: new AsyncLocalStorage<Map<unknown, Map<string, unknown>>>() };
});

// Model React's per-render memoization too: search must bypass it, not just the process-local cache.
vi.mock("react", () => ({
  cache:
    <Args extends unknown[], Value>(load: (...args: Args) => Value) =>
    (...args: Args): Value => {
      const values = renderCache.getStore();
      if (values === undefined) return load(...args);
      let entries = values.get(load);
      if (entries === undefined) {
        entries = new Map();
        values.set(load, entries);
      }
      const key = JSON.stringify(args);
      if (!entries.has(key)) entries.set(key, load(...args));
      return entries.get(key) as Value;
    },
}));
vi.mock("@/ontos/active-market", () => ({
  getActiveMarket: async () => ({ marketId: "search-test-market" }),
}));
vi.mock("@/ontos/config", () => ({
  getConfig: () => ({
    shellUrl: "http://owner-transport.test",
    apiKey: "test-only-storefront-key",
    legalEntityId: "search-test-legal-entity",
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/catalog-server", () => ({
  getCatalogPage: vi.fn<typeof getCatalogPage>(),
  readProducts: vi.fn<typeof readProducts>(),
}));

// The full record of p1 (search variant routing): two variants, one with an exact SKU.
const fullP1Body = {
  total: 1,
  page: 1,
  pageSize: 2,
  products: [
    {
      id: "p1",
      slug: "sroub-din-933-a2",
      sku: "933A2",
      name: "Šroub DIN 933 A2",
      active: true,
      published: true,
      availability: "IN_STOCK",
      imageSrc: "/akros/products/product-02.jpg",
      currency: "CZK",
      grossPriceMinor: 121,
      priceMinor: 100,
      variantSummary: { count: 2, minGrossPriceMinor: 121, stockOnHand: 40, units: ["ks"] },
      variantRecords: [
        {
          id: "v1",
          sku: "933A2M6",
          name: "M6 x 20",
          grossPriceMinor: 121,
          priceMinor: 100,
          stockOnHand: 20,
        },
        {
          id: "v2",
          sku: "933A2M8",
          name: "M8 x 20",
          grossPriceMinor: 254,
          priceMinor: 210,
          stockOnHand: 20,
        },
      ],
    },
  ],
};
const fullP1 = projectProducts(fullP1Body);
const exactOffer = (revision = 1) => ({
  ...fullP1Body.products[0].variantRecords[1],
  currency: "CZK",
  grossPriceMinor: 254 * revision,
  priceMinor: 210 * revision,
  displayPriceExcludingVatMinor: 207 * revision,
  availability: "IN_STOCK",
  unit: "ks",
  imageSrc: "/storefront/variant.jpg",
  minimumQuantity: 2,
  packageQuantity: 10,
});

// A listing card: no variant records, only the owner's variant summary.
const listingBody = {
  total: 37,
  page: 1,
  pageSize: 6,
  products: [
    {
      id: "p1",
      slug: "sroub-din-933-a2",
      sku: "933A2",
      name: "Šroub DIN 933 A2",
      active: true,
      published: true,
      availability: "IN_STOCK",
      imageSrc: "/akros/products/product-02.jpg",
      grossPriceMinor: 121,
      variantSummary: { count: 2, minGrossPriceMinor: 121, stockOnHand: 40, units: ["ks"] },
      searchMatch: { kind: "product" },
    },
  ],
};
const listing = projectProducts(listingBody);
const page: CatalogPage = {
  model: createCatalog(listing, {
    categories: [
      { id: "c1", parentId: null, hasChildren: true, slug: "srouby", name: "Šrouby", position: 1 },
      {
        id: "c2",
        parentId: "c1",
        hasChildren: false,
        slug: "din-933",
        name: "Šrouby DIN 933",
        position: 1,
      },
    ],
  }),
  products: listing.products,
  total: 37,
  page: 1,
  pageSize: 6,
};
const ask = (q: unknown, origin = "http://localhost:3070") =>
  POST(
    new Request("http://localhost:3070/api/ontos/search", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ q }),
    }),
  );

beforeEach(() => {
  vi.mocked(getCatalogPage).mockReset();
  vi.mocked(getCatalogPage).mockResolvedValue(page);
  vi.mocked(readProducts).mockReset();
  vi.mocked(readProducts).mockResolvedValue(fullP1);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("header search BFF", () => {
  it("asks OntOS for one small page and returns suggestion DTOs with the total", async () => {
    const response = await ask("  šroub ");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dynamic).toBe("force-dynamic");
    expect(fetchCache).toBe("force-no-store");
    expect(getCatalogPage).toHaveBeenCalledWith({ q: "šroub", page: 1, pageSize: 6 });
    expect(await response.json()).toEqual({
      total: 37,
      categories: [
        { id: "c1", slug: "srouby", name: "Šrouby", trail: "" },
        { id: "c2", slug: "din-933", name: "Šrouby DIN 933", trail: "Šrouby" },
      ],
      items: [
        {
          productId: "p1",
          slug: "sroub-din-933-a2",
          name: "Šroub DIN 933 A2",
          imageSrc: "/akros/products/product-02.jpg",
          currency: "CZK",
          priceMinor: 121,
          priceIsFrom: true,
          hasVariants: true,
          path: "/produkt/sroub-din-933-a2",
        },
      ],
    });
  });
  it("routes an exact variant SKU to that variant with its own price without a full read", async () => {
    const products = projectProducts({
      products: [
        {
          ...listingBody.products[0],
          searchMatch: {
            kind: "single",
            variant: exactOffer(),
          },
        },
      ],
    }).products;
    vi.mocked(getCatalogPage).mockResolvedValue({ ...page, products });
    const body = (await (await ask("933a2m8")).json()) as { items: unknown[] };
    expect(readProducts).not.toHaveBeenCalled();
    expect(body.items).toEqual([
      expect.objectContaining({
        priceMinor: 254,
        priceIsFrom: false,
        variantLabel: "M8 x 20",
        variantSku: "933A2M8",
        path: "/produkt/sroub-din-933-a2?variantIds=v2#product-variants",
      }),
    ]);
  });
  it("fails honestly for missing compact evidence instead of hydrating or inventing a filter link", async () => {
    vi.mocked(getCatalogPage).mockResolvedValue({
      ...page,
      products: page.products.map((product) => ({ ...product, searchMatch: undefined })),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await ask("M8");
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("items");
    expect(readProducts).not.toHaveBeenCalled();
  });
  it("does not read OntOS for fewer than two characters", async () => {
    expect(await (await ask("š")).json()).toEqual({ items: [], total: 0, categories: [] });
    expect(getCatalogPage).not.toHaveBeenCalled();
  });
  it("refuses cross-origin calls", async () => {
    expect((await ask("šroub", "https://evil.example")).status).toBe(403);
  });
});

describe("search messages follow the market language", () => {
  const askIn = (locale: string | undefined, origin?: string) =>
    POST(
      new Request("http://localhost:3070/api/ontos/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(origin === undefined ? {} : { origin }),
          ...(locale === undefined ? {} : { "x-akros-market-locale": locale }),
        },
        body: JSON.stringify({ q: "šroub" }),
      }),
    );
  it.each([
    [undefined, "Požadavek musí pocházet z tohoto obchodu."],
    ["sk", "Požiadavka musí pochádzať z tohto obchodu."],
    ["en", "The request must come from this shop."],
    ["de", "The request must come from this shop."],
  ])("refuses a cross-origin call for locale %s", async (locale, message) => {
    const response = await askIn(locale, "https://evil.example");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message });
  });
  it.each([
    [undefined, "Vyhledávání v OntOS je teď nedostupné. Zkuste to prosím za chvíli."],
    ["sk", "Vyhľadávanie v OntOS je teraz nedostupné. Skúste to prosím o chvíľu."],
    ["en", "Search in OntOS is unavailable right now. Please try again shortly."],
  ])("answers an outage for locale %s", async (locale, message) => {
    vi.mocked(getCatalogPage).mockRejectedValue(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await askIn(locale);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message });
  });
});

describe("fresh searches through the real catalog/gateway transport", () => {
  type Server = typeof import("@/ontos/catalog-server");
  type OwnerRequest = {
    audience: string;
    legalEntityId: string;
    readName: string;
    query: { view: { storefront: boolean; storefrontCatalog: Record<string, unknown> } };
  };
  let server: Server;
  let revision: number;
  let unavailable: boolean;
  let requests: OwnerRequest[];
  let transports: { url: string; init: RequestInit }[];
  let returnedGroups: number;
  let matchOverride: unknown;
  let omitEvidence: boolean;
  let hideProduct: boolean;
  let returnedVariantCount: number;

  beforeEach(async () => {
    // Only configuration, request market and the HTTP boundary are mocked. Catalog projection, caches,
    // query construction, gateway assertion parsing and shellFetch all execute their real code.
    vi.resetModules();
    server = await vi.importActual<Server>("@/ontos/catalog-server");
    vi.mocked(getCatalogPage).mockImplementation(server.getCatalogPage);
    vi.mocked(readProducts).mockImplementation(server.readProducts);
    revision = 1;
    unavailable = false;
    requests = [];
    transports = [];
    returnedGroups = 1;
    matchOverride = undefined;
    omitEvidence = false;
    hideProduct = false;
    returnedVariantCount = 2;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        transports.push({ url, init });
        const payload = JSON.parse(String(init.body)) as OwnerRequest;
        requests.push(payload);
        const query = payload.query.view.storefrontCatalog;
        const navigation = query.mode === "categories";
        const source = query.fields === "full" ? fullP1Body : listingBody;
        const publicControl = query.q === "10799700" || query.q === "10799700035016";
        const body = navigation
          ? { products: [], categories: page.model.getCategories() }
          : {
              ...source,
              revision,
              total: hideProduct
                ? 0
                : publicControl
                  ? 1
                  : returnedGroups > 1
                    ? returnedGroups
                    : revision === 1
                      ? source.total
                      : source.total + 1,
              market: {
                marketId: "search-test-market",
                marketCode: "CZ",
                currency: "CZK",
                configured: true,
              },
              products: hideProduct
                ? []
                : Array.from({ length: returnedGroups }, (_, index) => {
                    const product = source.products[0];
                    const selected = publicControl
                      ? { ...exactOffer(revision), id: "item-6692", sku: "10799700035016" }
                      : {
                          ...exactOffer(revision),
                          id: returnedGroups > 1 ? `fixture-leaf-${index}` : "v2",
                        };
                    const evidence =
                      query.q === "933a2m8" || query.q === "10799700035016" || returnedGroups > 1
                        ? { kind: "single", variant: selected }
                        : returnedVariantCount === 1
                          ? { kind: "product", onlyVariant: selected }
                          : { kind: "product" };
                    return {
                      ...product,
                      id: returnedGroups > 1 ? `fixture-product-${index}` : product.id,
                      ...(publicControl ? { sku: "10799700" } : {}),
                      searchMatch:
                        omitEvidence || !query.q
                          ? undefined
                          : matchOverride === undefined
                            ? evidence
                            : matchOverride,
                      variantSummary: {
                        ...product.variantSummary,
                        count: publicControl ? 47 : returnedVariantCount,
                        minGrossPriceMinor: revision === 1 ? 121 : 242,
                      },
                    };
                  }),
            };
        return new Response(
          JSON.stringify(unavailable && !navigation ? { code: "forbidden" } : body),
          {
            status: unavailable && !navigation ? 403 : 200,
            headers: {
              "content-type": "application/json",
              "x-ontos-gateway-context": JSON.stringify({
                apiBaseUrl: "/shell-super-app-api/merchandise",
                compositionRevision: "a".repeat(64),
                token: "test-only-redeemed-assertion",
                expiresAt: 1_800_000_000_000,
              }),
            },
          },
        );
      }),
    );
  });

  const productRequests = () =>
    requests
      .map(({ query }) => query.view.storefrontCatalog)
      .filter(({ mode }) => mode !== "categories");

  it("sends two identical searches to the owner immediately and observes a changed answer", async () => {
    await renderCache.run(new Map(), async () => {
      const first = await ask("šroub");
      const before = (await first.json()) as RemoteSearchResponse;
      revision = 2;
      // No timer advancement, cache invalidation or alternate query: even the render scope is the same.
      const second = await ask("šroub");
      const after = (await second.json()) as RemoteSearchResponse;
      expect(before).toMatchObject({ total: 37, items: [{ priceMinor: 121 }] });
      expect(after).toMatchObject({ total: 38, items: [{ priceMinor: 242 }] });
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(second.headers.get("cache-control")).toBe("no-store");
      expect(productRequests().filter(({ q }) => q === "šroub")).toEqual([
        {
          q: "šroub",
          page: 1,
          pageSize: 6,
          fields: "card",
          includeCategories: false,
          marketId: "search-test-market",
        },
        {
          q: "šroub",
          page: 1,
          pageSize: 6,
          fields: "card",
          includeCategories: false,
          marketId: "search-test-market",
        },
      ]);
      for (const { url, init } of transports) {
        expect(url).toBe(
          "http://owner-transport.test/shell-super-app-api/auth/api-key/gateway-read",
        );
        expect(init.method).toBe("POST");
        expect(init.cache).not.toBe("force-cache");
        expect(init).not.toHaveProperty("next");
      }
      for (const payload of requests)
        expect(payload).toMatchObject({
          audience: "merchandise",
          legalEntityId: "search-test-legal-entity",
          readName: "records",
          query: {
            view: { storefront: true, storefrontCatalog: { marketId: "search-test-market" } },
          },
        });
      // Navigation keeps its existing price-free cache; only query/variant answers must be fresh.
      expect(
        requests.filter(({ query }) => query.view.storefrontCatalog.mode === "categories"),
      ).toHaveLength(1);
    });
  });

  it("refreshes inline exact variant evidence without any ten-second full-product reuse", async () => {
    await renderCache.run(new Map(), async () => {
      const before = (await (await ask("933a2m8")).json()) as RemoteSearchResponse;
      revision = 2;
      const after = (await (await ask("933a2m8")).json()) as RemoteSearchResponse;
      expect(before.items[0]).toMatchObject({
        priceMinor: 254,
        variantLabel: "M8 x 20",
        variantSku: "933A2M8",
        path: "/produkt/sroub-din-933-a2?variantIds=v2#product-variants",
      });
      expect(after.items[0]).toMatchObject({
        priceMinor: 508,
        variantLabel: "M8 x 20",
        variantSku: "933A2M8",
        path: "/produkt/sroub-din-933-a2?variantIds=v2#product-variants",
      });
      expect(productRequests().filter(({ fields }) => fields === "full")).toHaveLength(0);
      expect(productRequests().filter(({ q }) => q === "933a2m8")).toHaveLength(2);
    });
  });

  it("does not coalesce concurrent identical searches", async () => {
    await renderCache.run(new Map(), () => Promise.all([ask("šroub"), ask("šroub")]));
    expect(productRequests().filter(({ q }) => q === "šroub")).toHaveLength(2);
  });

  it("does not serve a previous successful search when the owner refuses the next one", async () => {
    expect((await ask("šroub")).status).toBe(200);
    unavailable = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await ask("šroub");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("items");
    expect(productRequests().filter(({ q }) => q === "šroub")).toHaveLength(2);
  });

  it("preserves the public parent/leaf SKU routing controls without hydrating their 47-variant group", async () => {
    // Replays the parent-provided identities against a synthetic owner response, not a live acceptance run.
    const parent = (await (await ask("10799700")).json()) as RemoteSearchResponse;
    expect(parent.total).toBe(1);
    expect(parent.items).toHaveLength(1);
    expect(parent.items[0]).toMatchObject({ hasVariants: true, path: "/produkt/sroub-din-933-a2" });
    expect(parent.items[0].variantSku).toBeUndefined();
    const leaf = (await (await ask("10799700035016")).json()) as RemoteSearchResponse;
    expect(leaf.total).toBe(1);
    expect(leaf.items).toHaveLength(1);
    expect(leaf.items[0]).toMatchObject({
      variantSku: "10799700035016",
      priceMinor: 254,
      path: "/produkt/sroub-din-933-a2?variantIds=item-6692#product-variants",
    });
    const listing = await server.getCatalogPage({ q: "10799700", page: 1, pageSize: 6 });
    expect(listing.products[0].variantSummary.count).toBe(47);
    expect(productRequests().every(({ fields }) => fields === "card")).toBe(true);
    expect(readProducts).not.toHaveBeenCalled();
  });

  it("uses complete compact evidence for more than eight result groups, with no full reads", async () => {
    returnedGroups = 12;
    const listing = await server.getCatalogPage({ q: "variants", page: 1, pageSize: 24 });
    const matches = await readSearchVariantMatches(listing.products, "variants");
    expect(matches.size).toBe(12);
    const grids = listing.products.map((product) =>
      toSearchGridItem(
        listing.model.toProductSummary(product),
        "variants",
        cs,
        matches.get(product.id),
      ),
    );
    expect(grids.map(({ variantId }) => variantId)).toEqual(
      Array.from({ length: 12 }, (_, index) => `fixture-leaf-${index}`),
    );
    for (const grid of grids) {
      expect(grid).toMatchObject({
        imageSrc: "/storefront/variant.jpg",
        priceMinor: 254,
        priceExcludingVatMinor: 207,
        priceIsFrom: false,
        variantLabel: "M8 x 20",
        stock: {
          kind: "quantity",
          status: "in-stock",
          stockCount: 20,
          minimumQuantity: 10,
          packageQuantity: 10,
          quantityStep: 10,
          unit: "ks",
        },
      });
    }
    expect(productRequests()).toEqual([
      {
        q: "variants",
        page: 1,
        pageSize: 24,
        fields: "card",
        includeCategories: false,
        marketId: "search-test-market",
      },
    ]);
    expect(readProducts).not.toHaveBeenCalled();
  });

  it("keeps duplicate exact matches multiple and known-zero unattributed hits on base detail", async () => {
    matchOverride = { kind: "multiple", count: 2 };
    const multiple = (await (await ask("933a2m8")).json()) as RemoteSearchResponse;
    expect(multiple.items[0]).toMatchObject({
      priceIsFrom: true,
      path: "/produkt/sroub-din-933-a2?variant=933a2m8#product-variants",
    });
    expect(multiple.items[0].variantLabel).toBeUndefined();
    matchOverride = { kind: "unattributed" };
    const unattributed = (await (await ask("933a2m8")).json()) as RemoteSearchResponse;
    expect(unattributed.items[0].path).toBe("/produkt/sroub-din-933-a2");
    expect(unattributed.items[0].variantSku).toBeUndefined();
    expect(productRequests().filter(({ q }) => q === "933a2m8")).toHaveLength(2);
    expect(productRequests().every(({ fields }) => fields === "card")).toBe(true);
  });

  it("preserves true onlyVariant fallback in the header but not exact grid routing", async () => {
    returnedVariantCount = 1;
    const body = (await (await ask("šroub")).json()) as RemoteSearchResponse;
    expect(body.items[0]).toMatchObject({
      variantSku: "933A2M8",
      variantLabel: "M8 x 20",
      imageSrc: "/storefront/variant.jpg",
      priceMinor: 254,
      priceIsFrom: false,
      path: "/produkt/sroub-din-933-a2",
    });
    const listing = await server.getCatalogPage({ q: "šroub", pageSize: 24 });
    const matches = await readSearchVariantMatches(listing.products, "šroub");
    const grid = toSearchGridItem(
      listing.model.toProductSummary(listing.products[0]),
      "šroub",
      cs,
      matches.get("p1"),
    );
    expect(grid.variantId).toBeUndefined();
    expect(grid.detailHref).toBe("/produkt/sroub-din-933-a2");
    expect(grid.priceMinor).toBe(121);
    expect(productRequests().every(({ fields }) => fields === "card")).toBe(true);
  });

  it.each(["activity", "market offer"])(
    "observes immediate %s removal on the same query",
    async () => {
      expect(((await (await ask("933a2m8")).json()) as RemoteSearchResponse).items).toHaveLength(1);
      hideProduct = true;
      const body = (await (await ask("933a2m8")).json()) as RemoteSearchResponse;
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
      expect(productRequests().filter(({ q }) => q === "933a2m8")).toHaveLength(2);
    },
  );

  it.each([
    { kind: "single", variant: { ...exactOffer(), currency: "EUR" } },
    { kind: "single", variant: { ...exactOffer(), currency: "USD" } },
    { kind: "single", variant: { ...exactOffer(), id: "" } },
    { kind: "single", variant: { ...exactOffer(), grossPriceMinor: undefined } },
    { kind: "multiple", count: 1 },
    { kind: "multiple", count: 3 },
    { kind: "unattributed", onlyVariant: exactOffer() },
    { kind: "single", variant: [exactOffer()] },
    { kind: "product", variantIds: ["invented"] },
  ])("returns an honest uncached outage for malformed compact metadata %#", async (evidence) => {
    matchOverride = evidence;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await ask("933a2m8");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("items");
    expect(productRequests()).toHaveLength(1);
    expect(productRequests()[0].fields).toBe("card");
    expect(readProducts).not.toHaveBeenCalled();
  });

  it("does not use an unverified title or full-group fallback when evidence is absent", async () => {
    omitEvidence = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await ask("šroub")).status).toBe(503);
    expect(productRequests()).toHaveLength(1);
    expect(productRequests()[0].fields).toBe("card");
    expect(readProducts).not.toHaveBeenCalled();
  });

  it("leaves non-search product caching intact and explicit fresh cart/detail reads uncached", async () => {
    await server.readProducts({ slug: "sroub-din-933-a2", pageSize: 1 }, "full");
    revision = 2;
    await server.readProducts({ slug: "sroub-din-933-a2", pageSize: 1 }, "full");
    await server.readProducts({ slug: "sroub-din-933-a2", pageSize: 1, q: "" }, "full");
    expect(productRequests()).toHaveLength(1);
    await server.readProducts({ slug: "sroub-din-933-a2", pageSize: 1 }, "full", true);
    expect(productRequests()).toHaveLength(2);
  });
});
