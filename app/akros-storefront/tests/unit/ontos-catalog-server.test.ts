import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserAt, serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

type Server = typeof import("@/ontos/catalog-server");
type Query = { view: { storefrontCatalog: Record<string, unknown> } };
type Read = [string, string, Query];
const storefrontAppId = "sroubshop-storefront";
const czMarketId = "0b3d6c1e-2f4a-4c5b-8d6e-7f8091a2b3c4";
const skMarketId = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const requestMarket: { id: string | undefined } = { id: czMarketId };
const calls: Read[] = [];
const catalogOf = (call: Read) => {
  const { storefrontAppId: appId, marketId, ...query } = call[2].view.storefrontCatalog;
  expect(appId).toBe(storefrontAppId);
  expect(marketId).toBe(requestMarket.id);
  return query;
};
const category = (id: string, parentId: string | null, slug: string, content = false) => ({
  id,
  parentId,
  slug,
  name: slug,
  position: 1,
  hasChildren: false,
  ...(content
    ? {
        heading: `Nadpis ${slug}`,
        description: `Popis ${slug}`,
        longDescription: "Velmi dlouhý popis kategorie",
        imageSrc: "/akros/products/product-02.jpg",
        imageAlt: slug,
      }
    : {}),
});
const product = (id: string) => ({
  id,
  slug: id,
  name: id,
  active: true,
  availability: "IN_STOCK",
  grossPriceMinor: 121,
  currentPriceMinor: 100,
  stockOnHand: 5,
  minimumQuantity: 1,
  variantSummary: { count: 0, minGrossPriceMinor: null, stockOnHand: 0, units: [] },
});
const tree = [
  category("root", null, "nerezovy-spojovaci-material", true),
  category("srouby", "root", "srouby"),
  category("din", "srouby", "din-933"),
  category("din-a2", "din", "din-933-a2"),
  category("other", null, "jina-sekce", true),
];

let server: Server;
let network: Awaited<ReturnType<typeof serveHttp>>;
let requestContext: typeof nextRequest;
let ownerUnavailable = false;
let answer: (catalog: Record<string, unknown>) => unknown;
const legalEntityId = "71000000-0000-4000-8000-000000000024";
const effectivePeriod = { startsAt: "2020-01-01T00:00:00.000Z" };
const marketCatalog = () => {
  const markets =
    requestMarket.id === undefined
      ? []
      : [
          { marketId: czMarketId, locale: "cs", currency: "CZK" },
          { marketId: skMarketId, locale: "sk", currency: "EUR" },
        ];
  return {
    markets: markets.map(({ marketId, locale }) => ({
      marketRef: { resourceId: marketId },
      marketCode: `AKROS-${locale.toUpperCase()}`,
      supportedLocales: [locale],
      lifecycle: "ACTIVE",
      effectivePeriod,
      sellingLegalEntityRef: { resourceId: legalEntityId },
    })),
    associations: markets.map(({ marketId }) => ({
      marketRef: { resourceId: marketId },
      channel: "B2C",
      effectivePeriod,
      storefrontRef: { appId: storefrontAppId, tenantId: "test-tenant" },
      sellingLegalEntityRef: { resourceId: legalEntityId },
    })),
  };
};
async function inRequest<T>(action: () => T): Promise<Awaited<T>> {
  const context = requestContext("http://shop.test/", {
    headers: { "x-akros-market-locale": requestMarket.id === skMarketId ? "sk" : "cs" },
  });
  try {
    return await context.run(action);
  } finally {
    await context.close();
  }
}

// Next request stores supply headers/after, not React's render dispatcher. A native RSC
// render in a server-conditioned Node realm proves request memoization without replacing React.
async function renderConcurrentCatalog() {
  const require = createRequire(import.meta.url);
  const storefront = fileURLToPath(new NodeURL("../../", import.meta.url));
  const bundle = await build({
    stdin: {
      resolveDir: storefront,
      sourcefile: "ontos-catalog-server-render.ts",
      loader: "ts",
      contents: `
        import { cache, createElement } from "react";
        import { renderToReadableStream } from "next/dist/compiled/react-server-dom-webpack/server.node";
        import * as server from "./src/ontos/catalog-server";
        import { nextRequest } from "./tests/support/next-request";
        const context = nextRequest("http://shop.test/", {
          headers: { "x-akros-market-locale": "cs" },
        });
        let loads = 0;
        const memo = cache(() => ++loads);
        const probe = [];
        async function CatalogRender() {
          probe.push(memo());
          await Promise.all([
            server.getShellSnapshot(),
            server.getCategoryTree(undefined),
            server.getCategoryTree(""),
            server.getCatalogPage({ slug: "p1", pageSize: 1 }, { fields: "full" }),
            server.getCatalog(),
          ]);
          probe.push(memo());
          return "catalog render complete";
        }
        (async () => {
          try {
            await context.run(async () => {
              const errors = [];
              const stream = await renderToReadableStream(createElement(CatalogRender), {}, {
                onError(error) { errors.push(error); },
              });
              const payload = await new Response(stream).text();
              if (errors.length) throw errors[0];
              if (!payload.includes("catalog render complete")) throw new Error(payload);
            });
            process.send({ probe });
          } finally {
            await context.close();
            process.disconnect();
          }
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    tsconfig: fileURLToPath(new NodeURL("../../tsconfig.json", import.meta.url)),
    alias: { "server-only": require.resolve("next/dist/compiled/server-only/empty.js") },
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("Missing catalog RSC entry bundle");
  const probe = await new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--require",
        require.resolve("next/dist/server/node-environment-baseline"),
        "--input-type=commonjs",
      ],
      {
        cwd: storefront,
        env: process.env,
        signal: AbortSignal.timeout(10_000),
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    const { stdin, stdout, stderr: errors } = child;
    if (!stdin || !stdout || !errors) throw new Error("RSC process pipes were not created");
    let stderr = "";
    let completed = false;
    let result: unknown;
    errors.on("data", (chunk) => {
      stderr += String(chunk);
    });
    stdout.resume();
    child.on("error", reject);
    child.on("message", (message) => {
      if (typeof message === "object" && message !== null && "probe" in message) {
        completed = true;
        result = message.probe;
      }
    });
    child.on("close", (code) => {
      if (code !== 0 || !completed)
        reject(new Error(`Catalog RSC render exited ${code}: ${stderr}`));
      else resolve(result);
    });
    stdin.end(output.text);
  });
  expect(probe).toEqual([1, 1]);
}

beforeEach(async () => {
  vi.resetModules();
  requestMarket.id = czMarketId;
  calls.length = 0;
  ownerUnavailable = false;
  answer = (catalog) => ({
    revision: 5,
    ...(catalog.mode === "categories"
      ? { products: [] }
      : {
          total: 1,
          page: 1,
          pageSize: Number(catalog.pageSize ?? 24),
          homepageFeaturedProductIds: [],
          products: [product("p1")],
        }),
    ...(catalog.includeCategories || catalog.includeCategoryContent
      ? {
          categories: tree
            .filter(
              (node) =>
                !catalog.includeCategoryContent ||
                node.slug === catalog.categorySlug ||
                node.parentId === tree.find((entry) => entry.slug === catalog.categorySlug)?.id,
            )
            .map((node) =>
              node.slug === catalog.categorySlug
                ? category(node.id, node.parentId, node.slug, true)
                : node,
            ),
        }
      : {}),
  });
  network = await serveHttp(async (request) => {
    expect(new URL(request.url).pathname).toBe("/shell-super-app-api/auth/api-key/gateway-read");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-api-key")).toBe("catalog-server-test-key");
    const body = await request.json();
    const headers = {
      "x-ontos-gateway-context": JSON.stringify({
        apiBaseUrl: "/shell-super-app-api/merchandise",
        compositionRevision: "a".repeat(64),
        token: "catalog-server-test-assertion",
        expiresAt: Date.now() + 60_000,
      }),
    };
    if (body.audience === "commerce-market-catalog")
      return Response.json(marketCatalog(), { headers });
    const catalog = body.query.view.storefrontCatalog;
    // Market resolution's real offer reads are not product/navigation reads.
    if (Object.keys(catalog).sort().join(",") === "fields,includeCategories,marketId,pageSize")
      return Response.json(
        {
          market: {
            marketId: catalog.marketId,
            currency: catalog.marketId === skMarketId ? "EUR" : "CZK",
            configured: true,
          },
        },
        { headers },
      );
    calls.push([body.audience, body.readName, body.query]);
    if (ownerUnavailable)
      return Response.json({ code: "owner_unavailable" }, { status: 500, headers });
    return Response.json(answer(catalog), { headers });
  });
  browserAt(network.origin);
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "catalog-server-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", storefrontAppId);
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  ({ nextRequest: requestContext } = await import("../support/next-request"));
  server = await import("@/ontos/catalog-server");
});
afterEach(async () => {
  try {
    await network.idle();
    for (const call of calls)
      expect(call[2].view.storefrontCatalog.storefrontAppId).toBe(storefrontAppId);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await network.close();
  }
});

describe("OntOS catalog server reads", () => {
  it("keeps price-free navigation fresh for 15 minutes but refreshes home and detail after 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await inRequest(() => server.getCatalog());
    await inRequest(() => server.readProducts({ slug: "p1", pageSize: 1 }, "full"));
    await network.idle();
    calls.length = 0;
    vi.advanceTimersByTime(14 * 60_000);
    await inRequest(() => server.getShellSnapshot());
    await network.idle();
    expect(calls).toHaveLength(0);
    await inRequest(() => server.getCatalog());
    await inRequest(() => server.readProducts({ slug: "p1", pageSize: 1 }, "full"));
    expect(calls.map(catalogOf)).toEqual([
      { featured: true, pageSize: 20, fields: "card", includeCategories: false },
      { slug: "p1", pageSize: 1, fields: "full", includeCategories: false },
    ]);
    expect(server.CATALOG_CACHE_MS).toBe(10_000);
  });
  const pricedViews = [
    {
      name: "product detail",
      read: async () =>
        (await inRequest(() => server.readProducts({ slug: "p1", pageSize: 1 }, "full")))
          .products[0],
    },
    {
      name: "product listing",
      read: async () =>
        (await inRequest(() => server.getCatalogPage({ categorySlug: "srouby", pageSize: 24 })))
          .products[0],
    },
    {
      name: "category first page",
      read: async () =>
        (await inRequest(() => server.getCategoryListing({ categorySlug: "srouby", pageSize: 24 })))
          .products[0],
    },
    {
      name: "home selection",
      read: async () => (await inRequest(() => server.getCatalog())).getProducts()[0],
    },
  ];
  it.each(pricedViews)(
    "shows an admin price and stock edit on the very next $name view after 10 seconds",
    async ({ read }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      expect(await read()).toMatchObject({ priceMinor: 121, stockCount: 5 });
      answer = () => ({
        revision: 6,
        total: 1,
        page: 1,
        pageSize: 24,
        homepageFeaturedProductIds: [],
        products: [{ ...product("p1"), grossPriceMinor: 242, stockOnHand: 2 }],
        categories: tree,
      });
      const before = calls.length;
      vi.advanceTimersByTime(9_999);
      expect(await read()).toMatchObject({ priceMinor: 121, stockCount: 5 });
      await network.idle();
      expect(calls).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(await read()).toMatchObject({ priceMinor: 242, stockCount: 2 });
      await network.idle();
      expect(calls).toHaveLength(before + 1);
    },
  );
  it.each(pricedViews)(
    "rejects expired $name prices when the owner is unavailable instead of rendering old data",
    async ({ read }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      await read();
      vi.advanceTimersByTime(10_000);
      ownerUnavailable = true;
      await expect(read()).rejects.toThrow("owner_unavailable");
    },
  );
  it("reads products as bounded cards without the category tree and without unset keys", async () => {
    await inRequest(() =>
      server.readProducts(
        { categorySlug: "srouby", page: 2, pageSize: 24, q: "", minMinor: undefined },
        "card",
      ),
    );
    await network.idle();
    expect(calls).toEqual([
      [
        "merchandise",
        "records",
        {
          view: {
            storefront: true,
            storefrontCatalog: {
              categorySlug: "srouby",
              page: 2,
              pageSize: 24,
              fields: "card",
              includeCategories: false,
              storefrontAppId,
              marketId: czMarketId,
            },
          },
        },
      ],
    ]);
  });
  it("answers every read for the request's market and keys the caches by market", async () => {
    await inRequest(() => server.readProducts({ slug: "cache-test", pageSize: 1 }, "full"));
    await inRequest(() => server.getCategoryTree());
    requestMarket.id = skMarketId;
    await inRequest(() => server.readProducts({ slug: "cache-test", pageSize: 1 }, "full"));
    await inRequest(() => server.getCategoryTree());
    expect(calls.map((call) => (call[2] as Query).view.storefrontCatalog.marketId)).toEqual([
      czMarketId,
      czMarketId,
      skMarketId,
      skMarketId,
    ]);
    requestMarket.id = czMarketId;
    await inRequest(() => server.readProducts({ slug: "cache-test", pageSize: 1 }, "full"));
    await inRequest(() => server.getCategoryTree());
    await network.idle();
    expect(calls).toHaveLength(4);
  });
  it("sends no market before any market exists (the whole CZK catalogue)", async () => {
    requestMarket.id = undefined;
    await inRequest(() => server.readProducts({ slug: "cache-test", pageSize: 1 }, "full"));
    await inRequest(() => server.getCategoryTree());
    for (const call of calls)
      expect((call[2] as Query).view.storefrontCatalog).not.toHaveProperty("marketId");
    await network.idle();
    expect(calls).toHaveLength(2);
  });
  it("caches equal product queries briefly and bypasses the cache for fresh reads", async () => {
    await inRequest(() => server.readProducts({ slug: "cache-test", pageSize: 1 }, "full"));
    await inRequest(() => server.readProducts({ slug: "cache-test", pageSize: 1 }, "full"));
    await network.idle();
    expect(calls).toHaveLength(1);
    await inRequest(() => server.readProducts({ slug: "cache-test", pageSize: 1 }, "full", true));
    await network.idle();
    expect(calls).toHaveLength(2);
    expect(server.CATALOG_CACHE_MS).toBeLessThanOrEqual(15_000);
  });
  it("reads the navigation tree once per cache window, separately from products", async () => {
    await inRequest(() => server.getCatalogPage({ q: "a", pageSize: 24 }));
    await inRequest(() => server.getCatalogPage({ q: "b", pageSize: 24 }));
    await network.idle();
    const queries = calls.map(catalogOf);
    expect(queries.filter((call) => call.includeCategories === true)).toEqual([
      { mode: "categories", includeCategories: true },
    ]);
    expect(queries.filter((call) => call.includeCategories === false)).toHaveLength(2);
    expect(server.CATEGORY_CACHE_MS).toBe(15 * 60_000);
  });
  it("joins layout and page tree reads with omitted, undefined and empty arguments", async () => {
    await renderConcurrentCatalog();
    await network.idle();
    const queries = calls.map(catalogOf);
    expect(queries.filter((call) => call.includeCategories)).toHaveLength(1);
    expect(queries).toHaveLength(3);
  });
  it("adds the content of the requested category from its own detail read", async () => {
    const model = await inRequest(() => server.getCatalog("srouby"));
    expect(calls.map(catalogOf)).toContainEqual({
      categorySlug: "srouby",
      page: 1,
      pageSize: 24,
      sort: "name",
      fields: "card",
      includeCategories: false,
      includeCategoryContent: true,
    });
    expect(model.getCategoryBySlug("srouby")).toMatchObject({
      heading: "Nadpis srouby",
      description: "Popis srouby",
      longDescription: "Velmi dlouhý popis kategorie",
    });
    // Navigation-only nodes have no content fields.
    expect(model.getCategoryBySlug("din-933")).toMatchObject({
      description: undefined,
      imageSrc: undefined,
    });
    expect(model.getProducts().map((p) => p.id)).toEqual(["p1"]);
  });
  it("reads a category's tree and its unfiltered first listing page in one owner read", async () => {
    // (Within one page render React's request cache also joins the two concurrent calls.)
    const model = await inRequest(() => server.getCatalog("srouby"));
    const listing = await inRequest(() =>
      server.getCategoryListing({
        categorySlug: "srouby",
        pageSize: 24,
        sort: "name",
        page: 1,
      }),
    );
    await network.idle();
    const queries = calls.map(catalogOf);
    expect(queries.filter((call) => call.categorySlug === "srouby")).toHaveLength(1);
    expect(model.getCategoryBySlug("srouby")?.heading).toBe("Nadpis srouby");
    expect(listing.products.map((p) => p.id)).toEqual(["p1"]);
    // Another page or a filter is its own product read, without the tree.
    await inRequest(() =>
      server.getCategoryListing({
        categorySlug: "srouby",
        pageSize: 24,
        sort: "name",
        page: 2,
      }),
    );
    await inRequest(() =>
      server.getCategoryListing({ categorySlug: "srouby", pageSize: 24, sort: "price-asc" }),
    );
    expect(
      calls
        .map(catalogOf)
        .filter((call) => call.categorySlug === "srouby")
        .map(({ page, sort, includeCategories }) => ({ page, sort, includeCategories })),
    ).toEqual([
      { page: 1, sort: "name", includeCategories: false },
      { page: 2, sort: "name", includeCategories: false },
      { page: undefined, sort: "price-asc", includeCategories: false },
    ]);
  });
  it("keeps only category content for fifteen minutes while product prices expire after ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const first = await inRequest(() => server.getCatalog("srouby"));
    expect(first.getCategoryBySlug("srouby")?.longDescription).toBe("Velmi dlouhý popis kategorie");
    expect(calls.map(catalogOf).filter((query) => query.categorySlug)).toEqual([
      {
        categorySlug: "srouby",
        page: 1,
        pageSize: 24,
        sort: "name",
        fields: "card",
        includeCategories: false,
        includeCategoryContent: true,
      },
    ]);
    await network.idle();
    calls.length = 0;
    vi.advanceTimersByTime(10_000);
    const next = await inRequest(() => server.getCatalog("srouby"));
    expect(next.getCategoryBySlug("srouby")).toEqual(first.getCategoryBySlug("srouby"));
    expect(calls.map(catalogOf).filter((query) => query.categorySlug)).toEqual([
      {
        categorySlug: "srouby",
        page: 1,
        pageSize: 24,
        sort: "name",
        fields: "card",
        includeCategories: false,
      },
    ]);
    expect(
      calls
        .map(catalogOf)
        .every((query) => !query.includeCategories && !query.includeCategoryContent),
    ).toBe(true);
  });
  it("loads navigation on demand and keeps product reads separate", async () => {
    await inRequest(() => server.getShellSnapshot());
    expect(calls.map(catalogOf)).toEqual([{ mode: "categories", includeCategories: true }]);
    await inRequest(() => server.getShellSnapshot());
    await network.idle();
    expect(calls).toHaveLength(1);
    await network.idle();
    calls.length = 0;
    await inRequest(() =>
      Promise.all([
        server.getShellSnapshot(),
        server.getCatalog(),
        server.getCatalogPage({ slug: "p1", pageSize: 1 }, { fields: "full" }),
      ]),
    );
    expect(calls.map(catalogOf)).toEqual([
      { featured: true, pageSize: 20, fields: "card", includeCategories: false },
      { slug: "p1", pageSize: 1, fields: "full", includeCategories: false },
    ]);
    await network.idle();
    calls.length = 0;
    await inRequest(() => server.getCategoryListing({ categorySlug: "srouby", pageSize: 24 }));
    expect(calls.map(catalogOf)).toEqual([
      {
        categorySlug: "srouby",
        page: 1,
        pageSize: 24,
        sort: "name",
        fields: "card",
        includeCategories: false,
        includeCategoryContent: true,
      },
    ]);
  });
  it("reads product detail in full and listings as cards", async () => {
    await inRequest(() => server.getCatalogPage({ slug: "p1", pageSize: 1 }, { fields: "full" }));
    await inRequest(() => server.getCatalogPage({ categorySlug: "srouby", pageSize: 24 }));
    const products = calls.map(catalogOf).filter((call) => call.includeCategories === false);
    expect(products.map((call) => call.fields)).toEqual(["full", "card"]);
  });
  it("reads the cart's products fresh, in full, with only the cart's variants", async () => {
    await inRequest(() =>
      server.readCartProducts([
        { productId: "p1", variantId: "v1" },
        { productId: "p1", variantId: "v2" },
        { productId: "p2" },
      ]),
    );
    await inRequest(() => server.readCartProducts([{ productId: "p1", variantId: "v1" }]));
    expect(calls.map(catalogOf)).toEqual([
      {
        productIds: ["p1", "p2"],
        variantIds: ["v1", "v2"],
        pageSize: 2,
        fields: "full",
        includeCategories: false,
      },
      {
        productIds: ["p1"],
        variantIds: ["v1"],
        pageSize: 1,
        fields: "full",
        includeCategories: false,
      },
    ]);
  });
  it("ships only the slim navigation to the layout: no products, no deep categories", async () => {
    const snapshot = await inRequest(() => server.getShellSnapshot());
    expect(calls.map(catalogOf)).toEqual([{ mode: "categories", includeCategories: true }]);
    expect(snapshot.catalog.products).toEqual([]);
    expect(snapshot.categories.categories.map((c) => c.id)).toEqual(["root", "srouby"]);
    expect(snapshot.categories.categories[0]).toEqual({
      id: "root",
      parentId: null,
      hasChildren: true,
      slug: "nerezovy-spojovaci-material",
      name: "nerezovy-spojovaci-material",
      position: 1,
      imageSrc: "/akros/products/product-02.jpg",
      imageAlt: "nerezovy-spojovaci-material",
    });
    // A category page adds only its own trail and the children of each trail level.
    const branch = await inRequest(() => server.getCategoryBranch("din-933"));
    expect(branch.map((c) => c.id)).toEqual(["din", "din-a2"]);
    expect(branch[0]).not.toHaveProperty("longDescription");
  });
  it("maps storefront sections to owner labels and merges promotion reads", async () => {
    answer = (catalog) => {
      return {
        revision: 5,
        homepageFeaturedProductIds: [],
        categories: catalog.includeCategories ? tree : undefined,
        products:
          catalog.label === "action"
            ? [product("p-action"), product("p-both")]
            : [product("p-both"), product("p-sale")],
      };
    };
    const page = await inRequest(() => server.getCatalogPage({ flag: "promotion", pageSize: 48 }));
    const sent = calls.map(catalogOf).filter((call) => call.includeCategories === false);
    expect(sent).toEqual([
      { pageSize: 48, label: "action", fields: "card", includeCategories: false },
      { pageSize: 48, label: "sale", fields: "card", includeCategories: false },
    ]);
    expect(page.products.map((p) => p.id)).toEqual(["p-action", "p-both", "p-sale"]);
    await inRequest(() => server.getCatalogPage({ flag: "new", pageSize: 48 }));
    expect(catalogOf(calls.at(-1)!)).toEqual({
      pageSize: 48,
      label: "new",
      fields: "card",
      includeCategories: false,
    });
  });
});
