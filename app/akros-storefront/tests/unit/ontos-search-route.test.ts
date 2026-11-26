// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toSearchGridItem, type RemoteSearchResponse } from "@/ontos/search-suggestions";
import { readSearchVariantMatches } from "@/ontos/search-variants";
import { cs } from "@/i18n/cs";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

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
const categories = [
  { id: "c1", parentId: null, hasChildren: true, slug: "srouby", name: "Šrouby", position: 1 },
  {
    id: "c2",
    parentId: "c1",
    hasChildren: false,
    slug: "din-933",
    name: "Šrouby DIN 933",
    position: 1,
  },
];
const legalEntityId = "71000000-0000-4000-8000-000000000024";
type OwnerRequest = {
  audience: string;
  legalEntityId: string;
  readName: string;
  query: { view: { storefront: boolean; storefrontCatalog: Record<string, unknown> } };
};
let server: typeof import("@/ontos/catalog-server");
let route: typeof import("@/app/api/ontos/search/route");
let network: Awaited<ReturnType<typeof serveHttp>>;
let context: ReturnType<typeof nextRequest>;
let revision: number;
let unavailable: boolean;
let requests: OwnerRequest[];
let returnedGroups: number;
let matchOverride: unknown;
let omitEvidence: boolean;
let hideProduct: boolean;
let returnedVariantCount: number;

// Market-directory and market-offer discovery are genuine prerequisite HTTP reads, not search reads.
const productRequests = () =>
  requests
    .map(({ query }) => query.view.storefrontCatalog)
    .filter((query) => query.mode !== "categories");
const noFullReads = async () => {
  await network.idle();
  expect(
    requests.filter(({ query }) => query.view.storefrontCatalog.fields === "full"),
  ).toHaveLength(0);
};
const ask = (q: unknown, origin = "http://localhost:3070") =>
  context.run(() =>
    route.POST(
      new Request("http://localhost:3070/api/ontos/search", {
        method: "POST",
        headers: { origin, "content-type": "application/json", "x-akros-market-locale": "cs" },
        body: JSON.stringify({ q }),
      }),
    ),
  );

beforeEach(async () => {
  // Fresh real module instances isolate the process caches without replacing any export.
  vi.resetModules();
  revision = 1;
  unavailable = false;
  requests = [];
  returnedGroups = 1;
  matchOverride = undefined;
  omitEvidence = false;
  hideProduct = false;
  returnedVariantCount = 2;
  network = await serveHttp(async (request) => {
    if (new URL(request.url).pathname !== "/shell-super-app-api/auth/api-key/gateway-read")
      return new Response("Unknown gateway path", { status: 404 });
    const payload: OwnerRequest = await request.json();
    const headers = {
      "x-ontos-gateway-context": JSON.stringify({
        apiBaseUrl: "/shell-super-app-api/merchandise",
        compositionRevision: "a".repeat(64),
        token: "test-only-redeemed-assertion",
        expiresAt: 1_800_000_000_000,
      }),
    };
    if (payload.audience === "commerce-market-catalog") {
      const marketRef = { resourceId: "search-test-market" };
      const sellingLegalEntityRef = { resourceId: legalEntityId };
      const effectivePeriod = { startsAt: "2020-01-01T00:00:00Z" };
      return Response.json(
        {
          markets: [
            {
              marketRef,
              sellingLegalEntityRef,
              effectivePeriod,
              marketCode: "CZ",
              supportedLocales: ["cs-CZ"],
              lifecycle: "ACTIVE",
            },
          ],
          associations: [
            {
              marketRef,
              sellingLegalEntityRef,
              effectivePeriod,
              storefrontRef: { appId: "akros-storefront", tenantId: "search-test-tenant" },
              channel: "B2C",
            },
          ],
        },
        { headers },
      );
    }
    if (payload.audience !== "merchandise" || payload.readName !== "records")
      return new Response("Unknown owner read", { status: 404 });
    requests.push(payload);
    const query = payload.query.view.storefrontCatalog;
    const categoriesOnly = query.mode === "categories";
    const navigation = categoriesOnly && query.includeCategories !== false;
    const market = {
      marketId: "search-test-market",
      marketCode: "CZ",
      currency: "CZK",
      configured: true,
    };
    const source = query.fields === "full" ? fullP1Body : listingBody;
    const publicControl = query.q === "10799700" || query.q === "10799700035016";
    const body = categoriesOnly
      ? { products: [], market, ...(navigation ? { categories } : {}) }
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
          market,
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
    return Response.json(unavailable && !navigation ? { code: "forbidden" } : body, {
      status: unavailable && !navigation ? 403 : 200,
      headers,
    });
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "test-only-storefront-key");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", "akros-storefront");
  server = await import("@/ontos/catalog-server");
  route = await import("@/app/api/ontos/search/route");
  const { nextRequest: requestContext } = await import("../support/next-request");
  context = requestContext("http://localhost:3070/api/ontos/search", {
    headers: { "x-akros-market-locale": "cs" },
  });
});

afterEach(async () => {
  try {
    await context.close();
    await network.idle();
  } finally {
    await network.close();
    vi.unstubAllEnvs();
  }
});

describe("header search BFF", () => {
  it("asks OntOS for one small page and returns suggestion DTOs with the total", async () => {
    const response = await ask("  šroub ");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.fetchCache).toBe("force-no-store");
    await network.idle();
    expect(productRequests()).toEqual([
      {
        q: "šroub",
        page: 1,
        pageSize: 6,
        fields: "card",
        includeCategories: false,
        storefrontAppId: "akros-storefront",
        marketId: "search-test-market",
      },
    ]);
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
    const body = (await (await ask("933a2m8")).json()) as { items: unknown[] };
    await noFullReads();
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
    omitEvidence = true;
    const response = await ask("M8");
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("items");
    await noFullReads();
  });
  it("does not read OntOS for fewer than two characters", async () => {
    expect(await (await ask("š")).json()).toEqual({ items: [], total: 0, categories: [] });
    await network.idle();
    expect(network.requests).toHaveLength(0);
  });
  it("refuses cross-origin calls", async () => {
    expect((await ask("šroub", "https://evil.example")).status).toBe(403);
  });
});

describe("search messages follow the market language", () => {
  const askIn = (locale: string | undefined, origin?: string) =>
    context.run(() =>
      route.POST(
        new Request("http://localhost:3070/api/ontos/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(origin === undefined ? {} : { origin }),
            ...(locale === undefined ? {} : { "x-akros-market-locale": locale }),
          },
          body: JSON.stringify({ q: "šroub" }),
        }),
      ),
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
    unavailable = true;
    const response = await askIn(locale);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message });
  });
});

describe("fresh searches through the real catalog/gateway transport", () => {
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
    const listing = await context.run(() =>
      server.getCatalogPage({ q: "10799700", page: 1, pageSize: 6 }),
    );
    expect(listing.products[0].variantSummary.count).toBe(47);
    await network.idle();
    expect(productRequests().every(({ fields }) => fields === "card")).toBe(true);
    await noFullReads();
  });

  it("uses complete compact evidence for more than eight result groups, with no full reads", async () => {
    returnedGroups = 12;
    const listing = await context.run(() =>
      server.getCatalogPage({ q: "variants", page: 1, pageSize: 24 }),
    );
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
          minimumQuantity: 2,
          packageQuantity: 10,
          quantityStep: 2,
          unit: "ks",
        },
      });
    }
    await network.idle();
    expect(productRequests()).toEqual([
      {
        q: "variants",
        page: 1,
        pageSize: 24,
        fields: "card",
        includeCategories: false,
        storefrontAppId: "akros-storefront",
        marketId: "search-test-market",
      },
    ]);
    await noFullReads();
  });

  it("keeps duplicate exact matches multiple and known-zero unattributed hits on base detail", async () => {
    matchOverride = { kind: "multiple", count: 2 };
    const multiple = (await (await ask("933a2m8")).json()) as RemoteSearchResponse;
    expect(multiple.items[0]).toMatchObject({
      priceIsFrom: true,
      path: "/produkt/sroub-din-933-a2?variant=933a2m8#product-variants",
    });
    expect(multiple.items[0].variantLabel).toBeUndefined();
    await network.idle();
    expect(productRequests().filter(({ q }) => q === "933a2m8")).toHaveLength(1);
    await network.idle();
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
    const listing = await context.run(() => server.getCatalogPage({ q: "šroub", pageSize: 24 }));
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
    await network.idle();
    expect(productRequests().every(({ fields }) => fields === "card")).toBe(true);
  });

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
    const response = await ask("933a2m8");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("items");
    await network.idle();
    expect(productRequests()).toHaveLength(1);
    await network.idle();
    expect(productRequests()[0].fields).toBe("card");
    await noFullReads();
  });

  it("does not use an unverified title or full-group fallback when evidence is absent", async () => {
    omitEvidence = true;
    expect((await ask("šroub")).status).toBe(503);
    await network.idle();
    expect(productRequests()).toHaveLength(1);
    await network.idle();
    expect(productRequests()[0].fields).toBe("card");
    await noFullReads();
  });
});
