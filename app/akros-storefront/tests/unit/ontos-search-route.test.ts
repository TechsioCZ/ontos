// @vitest-environment node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
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
    .filter(
      (query) =>
        query.mode !== "categories" &&
        !(
          Object.keys(query).length === 4 &&
          query.marketId === "search-test-market" &&
          query.pageSize === 1 &&
          query.fields === "card" &&
          query.includeCategories === false
        ),
    );
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

// A separate Node realm selects React's published server condition, as Next does. Bundle only our
// TypeScript; React, Next and Effect stay their real installed packages. No export is replaced.
async function renderSearches(query: string, concurrent = false) {
  const require = createRequire(import.meta.url);
  const entry = `
    import { cache, createElement } from "react";
    import { renderToReadableStream } from "next/dist/compiled/react-server-dom-webpack/server.node";
    import { POST } from "./src/app/api/ontos/search/route";
    import { nextRequest } from "./tests/support/next-request";
    import { once } from "node:events";
    import { Session } from "node:inspector";
    import { promisify } from "node:util";
    const inspector = new Session();
    inspector.connect();
    const post = promisify(inspector.post.bind(inspector));
    const transports = [];
    inspector.on("Debugger.paused", ({ params }) => {
      inspector.post("Debugger.evaluateOnCallFrame", {
        callFrameId: params.callFrames[0].callFrameId, returnByValue: true,
        expression: '({ url: arguments[0], init: { method: arguments[1]?.method, cache: arguments[1]?.cache, ...("next" in (arguments[1] ?? {}) ? { next: true } : {}) } })',
      }, (error, result) => {
        if (error || result.exceptionDetails) throw error ?? new Error("Cannot observe fetch arguments");
        transports.push(result.result.value);
      });
      inspector.post("Debugger.resume");
    });
    const query = ${JSON.stringify(query)};
    const concurrent = ${JSON.stringify(concurrent)};
    const context = nextRequest("http://localhost:3070/api/ontos/search", {
      headers: { "x-akros-market-locale": "cs" },
    });
    let loads = 0;
    const memo = cache(() => ++loads);
    const probe = [];
    const responses = [];
    const ask = () => POST(new Request("http://localhost:3070/api/ontos/search", {
      method: "POST", headers: { "content-type": "application/json", "origin": "http://localhost:3070" },
      body: JSON.stringify({ q: query }),
    }));
    async function SearchRender() {
      probe.push(memo());
      if (concurrent) responses.push(...await Promise.all([ask(), ask()]));
      else {
        responses.push(await ask());
        const continued = once(process, "message");
        process.send({ phase: "first-response" });
        await continued;
        responses.push(await ask());
      }
      probe.push(memo());
      return null;
    }
    (async () => {
      try {
        await post("Debugger.enable");
        const { result: fetchFunction } = await post("Runtime.evaluate", { expression: "globalThis.fetch" });
        await post("Debugger.setBreakpointOnFunctionCall", { objectId: fetchFunction.objectId });
        await context.run(async () => {
          const stream = await renderToReadableStream(createElement(SearchRender), {});
          await new Response(stream).text();
        });
        const result = await Promise.all(responses.map(async response => ({
          status: response.status, headers: [...response.headers], body: await response.text(),
        })));
        process.send({ phase: "complete", responses: result, probe, transports });
      } finally { inspector.disconnect(); await context.close(); process.disconnect(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const bundle = await build({
    stdin: {
      contents: entry,
      resolveDir: process.cwd(),
      sourcefile: "ontos-search-route-render.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    tsconfig: "tsconfig.json",
    alias: { "server-only": require.resolve("next/dist/compiled/server-only/empty.js") },
  });
  type RenderResult = {
    phase: "complete";
    responses: { status: number; headers: [string, string][]; body: string }[];
    probe: number[];
    transports: { url: string; init: { method?: string; cache?: RequestCache; next?: true } }[];
  };
  const result = await new Promise<RenderResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--require",
        require.resolve("next/dist/server/node-environment-baseline"),
        "--input-type=commonjs",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    const { stdin, stdout, stderr: errors } = child;
    if (!stdin || !stdout || !errors) throw new Error("RSC process pipes were not created");
    let stderr = "";
    let completed: RenderResult | undefined;
    errors.on("data", (chunk) => {
      stderr += String(chunk);
    });
    stdout.resume();
    child.on("error", reject);
    child.on("message", (message: { phase: string } | RenderResult) => {
      if (message.phase === "first-response") {
        revision = 2;
        child.send("continue");
      } else if ("responses" in message && "probe" in message) completed = message;
    });
    child.on("close", (code) => {
      if (code !== 0 || !completed)
        reject(new Error(`React server render exited ${code}: ${stderr}`));
      else resolve(completed);
    });
    stdin.end(bundle.outputFiles[0].text);
  });
  // This control proves the real renderer's cache dispatcher actually memoized across awaits.
  expect(result.probe).toEqual([1, 1]);
  return {
    responses: result.responses.map(
      ({ body, status, headers }) => new Response(body, { status, headers }),
    ),
    transports: result.transports,
  };
}

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
    const navigation = query.mode === "categories";
    const source = query.fields === "full" ? fullP1Body : listingBody;
    const publicControl = query.q === "10799700" || query.q === "10799700035016";
    const body = navigation
      ? { products: [], categories }
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
  it("sends two identical searches to the owner immediately and observes a changed answer", async () => {
    await context.run(async () => {
      // Both calls run inside one genuine React server render and one Next request context.
      const {
        responses: [first, second],
        transports,
      } = await renderSearches("šroub");
      const before = (await first.json()) as RemoteSearchResponse;
      const after = (await second.json()) as RemoteSearchResponse;
      expect(before).toMatchObject({ total: 37, items: [{ priceMinor: 121 }] });
      expect(after).toMatchObject({ total: 38, items: [{ priceMinor: 242 }] });
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(second.headers.get("cache-control")).toBe("no-store");
      await network.idle();
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
      await network.idle();
      // V8 observes the real native fetch entry without replacing it; HTTP proves delivery too.
      expect(transports).toHaveLength(network.requests.length);
      for (const { url, init } of transports) {
        expect(url).toBe(`${network.origin}/shell-super-app-api/auth/api-key/gateway-read`);
        expect(init.method).toBe("POST");
        expect(init.cache).not.toBe("force-cache");
        expect(init).not.toHaveProperty("next");
      }
      for (const request of network.requests) {
        expect(request.url).toBe(`${network.origin}/shell-super-app-api/auth/api-key/gateway-read`);
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-api-key")).toBe("test-only-storefront-key");
      }
      expect(route.fetchCache).toBe("force-no-store");
      for (const payload of requests)
        expect(payload).toMatchObject({
          audience: "merchandise",
          legalEntityId,
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
    await context.run(async () => {
      const {
        responses: [first, second],
      } = await renderSearches("933a2m8");
      const before = (await first.json()) as RemoteSearchResponse;
      const after = (await second.json()) as RemoteSearchResponse;
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
      await network.idle();
      expect(productRequests().filter(({ fields }) => fields === "full")).toHaveLength(0);
      expect(productRequests().filter(({ q }) => q === "933a2m8")).toHaveLength(2);
    });
  });

  it("does not coalesce concurrent identical searches", async () => {
    await renderSearches("šroub", true);
    await network.idle();
    expect(productRequests().filter(({ q }) => q === "šroub")).toHaveLength(2);
  });

  it("does not serve a previous successful search when the owner refuses the next one", async () => {
    expect((await ask("šroub")).status).toBe(200);
    unavailable = true;
    const response = await ask("šroub");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("items");
    await network.idle();
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
          minimumQuantity: 10,
          packageQuantity: 10,
          quantityStep: 10,
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
    matchOverride = { kind: "unattributed" };
    const unattributed = (await (await ask("933a2m8")).json()) as RemoteSearchResponse;
    expect(unattributed.items[0].path).toBe("/produkt/sroub-din-933-a2");
    expect(unattributed.items[0].variantSku).toBeUndefined();
    await network.idle();
    expect(productRequests().filter(({ q }) => q === "933a2m8")).toHaveLength(2);
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

  it("leaves non-search product caching intact and explicit fresh cart/detail reads uncached", async () => {
    await context.run(() => server.readProducts({ slug: "sroub-din-933-a2", pageSize: 1 }, "full"));
    revision = 2;
    await context.run(() => server.readProducts({ slug: "sroub-din-933-a2", pageSize: 1 }, "full"));
    await context.run(() =>
      server.readProducts({ slug: "sroub-din-933-a2", pageSize: 1, q: "" }, "full"),
    );
    await network.idle();
    expect(productRequests()).toHaveLength(1);
    await context.run(() =>
      server.readProducts({ slug: "sroub-din-933-a2", pageSize: 1 }, "full", true),
    );
    await network.idle();
    expect(productRequests()).toHaveLength(2);
  });
});
