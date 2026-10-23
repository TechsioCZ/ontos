import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRecords } from "@/ontos/gateway";

const { renderCache } = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { renderCache: new AsyncLocalStorage<Map<unknown, Map<string, unknown>>>() };
});

// These cached functions take primitive arguments. Like React, preserve argument count in the key.
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
vi.mock("server-only", () => ({}));
vi.mock("@/ontos/gateway", () => ({ readRecords: vi.fn() }));

type Server = typeof import("@/ontos/catalog-server");
type Query = { view: { storefrontCatalog: Record<string, unknown> } };
const catalogOf = (call: unknown[]) => (call[2] as Query).view.storefrontCatalog;

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
beforeEach(async () => {
  // Fresh module per test: the product and navigation caches are process-local.
  vi.resetModules();
  server = await vi.importActual<Server>("@/ontos/catalog-server");
  vi.mocked(readRecords).mockReset();
  vi.mocked(readRecords).mockImplementation(async (_vertical, _read, query) => {
    const catalog = (query as Query).view.storefrontCatalog;
    return {
      revision: 5,
      total: 1,
      page: 1,
      pageSize: Number(catalog.pageSize ?? 24),
      homepageFeaturedProductIds: [],
      products: [product("p1")],
      ...(catalog.includeCategories
        ? {
            categories: tree.map((node) =>
              node.slug === catalog.categorySlug
                ? category(node.id, node.parentId, node.slug, true)
                : node,
            ),
          }
        : {}),
    };
  });
});

describe("OntOS catalog server reads", () => {
  it("reads products as bounded cards without the category tree and without unset keys", async () => {
    await server.readProducts(
      { categorySlug: "srouby", page: 2, pageSize: 24, q: "", minMinor: undefined },
      "card",
    );
    expect(readRecords).toHaveBeenCalledWith("merchandise", "records", {
      view: {
        storefront: true,
        storefrontCatalog: {
          categorySlug: "srouby",
          page: 2,
          pageSize: 24,
          fields: "card",
          includeCategories: false,
        },
      },
    });
  });
  it("caches equal product queries briefly and bypasses the cache for fresh reads", async () => {
    await server.readProducts({ slug: "cache-test", pageSize: 1 }, "full");
    await server.readProducts({ slug: "cache-test", pageSize: 1 }, "full");
    expect(readRecords).toHaveBeenCalledTimes(1);
    await server.readProducts({ slug: "cache-test", pageSize: 1 }, "full", true);
    expect(readRecords).toHaveBeenCalledTimes(2);
    expect(server.CATALOG_CACHE_MS).toBeLessThanOrEqual(15_000);
  });
  it("reads the navigation tree once per cache window, separately from products", async () => {
    await server.getCatalogPage({ q: "a", pageSize: 24 });
    await server.getCatalogPage({ q: "b", pageSize: 24 });
    const calls = vi.mocked(readRecords).mock.calls.map(catalogOf);
    expect(calls.filter((call) => call.includeCategories === true)).toEqual([
      { pageSize: 1, fields: "card", includeCategories: true },
    ]);
    expect(calls.filter((call) => call.includeCategories === false)).toHaveLength(2);
    expect(server.CATEGORY_CACHE_MS).toBe(60_000);
  });
  it("joins layout and page tree reads with omitted, undefined and empty arguments", async () => {
    await renderCache.run(new Map(), () =>
      Promise.all([
        server.getShellSnapshot(),
        server.getCategoryTree(undefined),
        server.getCategoryTree(""),
        server.getCatalogPage({ slug: "p1", pageSize: 1 }, { fields: "full" }),
        server.getCatalog(),
      ]),
    );
    const calls = vi.mocked(readRecords).mock.calls.map(catalogOf);
    expect(calls.filter((call) => call.includeCategories)).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });
  it("adds the content of the requested category from its own detail read", async () => {
    const model = await server.getCatalog("srouby");
    expect(vi.mocked(readRecords).mock.calls.map(catalogOf)).toContainEqual({
      categorySlug: "srouby",
      page: 1,
      pageSize: 24,
      sort: "name",
      fields: "card",
      includeCategories: true,
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
    const model = await server.getCatalog("srouby");
    const listing = await server.getCategoryListing({
      categorySlug: "srouby",
      pageSize: 24,
      sort: "name",
      page: 1,
    });
    const calls = vi.mocked(readRecords).mock.calls.map(catalogOf);
    expect(calls.filter((call) => call.categorySlug === "srouby")).toHaveLength(1);
    expect(model.getCategoryBySlug("srouby")?.heading).toBe("Nadpis srouby");
    expect(listing.products.map((p) => p.id)).toEqual(["p1"]);
    // Another page or a filter is its own product read, without the tree.
    await server.getCategoryListing({
      categorySlug: "srouby",
      pageSize: 24,
      sort: "name",
      page: 2,
    });
    await server.getCategoryListing({ categorySlug: "srouby", pageSize: 24, sort: "price-asc" });
    expect(
      vi
        .mocked(readRecords)
        .mock.calls.map(catalogOf)
        .filter((call) => call.categorySlug === "srouby")
        .map(({ page, sort, includeCategories }) => ({ page, sort, includeCategories })),
    ).toEqual([
      { page: 1, sort: "name", includeCategories: true },
      { page: 2, sort: "name", includeCategories: false },
      { page: undefined, sort: "price-asc", includeCategories: false },
    ]);
  });
  it("warms the tree, the homepage selection and every sidebar category, then skips young values", async () => {
    expect(await server.warmCatalog(60_000)).toEqual({ fresh: 0, refreshed: 4, failed: 0 });
    const calls = vi.mocked(readRecords).mock.calls.map(catalogOf);
    expect(calls).toContainEqual({ pageSize: 1, fields: "card", includeCategories: true });
    expect(calls).toContainEqual({
      featured: true,
      pageSize: 20,
      fields: "card",
      includeCategories: false,
    });
    expect(calls.map((call) => call.categorySlug).filter(Boolean)).toEqual([
      "nerezovy-spojovaci-material",
      "srouby",
    ]);
    expect(await server.warmCatalog(60_000)).toEqual({ fresh: 4, refreshed: 0, failed: 0 });
    expect(readRecords).toHaveBeenCalledTimes(4);
    // A page view of a warmed category needs no owner read.
    await server.getCatalog("srouby");
    expect(readRecords).toHaveBeenCalledTimes(4);
    // Product layout and recommendations use those same warmed keys; only detail reads the owner.
    vi.mocked(readRecords).mockClear();
    await renderCache.run(new Map(), () =>
      Promise.all([
        server.getShellSnapshot(),
        server.getCatalog(),
        server.getCatalogPage({ slug: "p1", pageSize: 1 }, { fields: "full" }),
      ]),
    );
    expect(vi.mocked(readRecords).mock.calls.map(catalogOf)).toEqual([
      { slug: "p1", pageSize: 1, fields: "full", includeCategories: false },
    ]);
  });
  it("reads product detail in full and listings as cards", async () => {
    await server.getCatalogPage({ slug: "p1", pageSize: 1 }, { fields: "full" });
    await server.getCatalogPage({ categorySlug: "srouby", pageSize: 24 });
    const products = vi
      .mocked(readRecords)
      .mock.calls.map(catalogOf)
      .filter((call) => call.includeCategories === false);
    expect(products.map((call) => call.fields)).toEqual(["full", "card"]);
  });
  it("reads the cart's products fresh, in full, with only the cart's variants", async () => {
    await server.readCartProducts([
      { productId: "p1", variantId: "v1" },
      { productId: "p1", variantId: "v2" },
      { productId: "p2" },
    ]);
    await server.readCartProducts([{ productId: "p1", variantId: "v1" }]);
    expect(vi.mocked(readRecords).mock.calls.map(catalogOf)).toEqual([
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
    const snapshot = await server.getShellSnapshot();
    expect(vi.mocked(readRecords).mock.calls.map(catalogOf)).toEqual([
      { pageSize: 1, fields: "card", includeCategories: true },
    ]);
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
    const branch = await server.getCategoryBranch("din-933");
    expect(branch.map((c) => c.id)).toEqual(["din", "din-a2"]);
    expect(branch[0]).not.toHaveProperty("longDescription");
  });
  it("maps storefront sections to owner labels and merges promotion reads", async () => {
    vi.mocked(readRecords).mockImplementation(async (_v, _r, query) => {
      const catalog = (query as Query).view.storefrontCatalog;
      return {
        revision: 5,
        homepageFeaturedProductIds: [],
        categories: catalog.includeCategories ? tree : undefined,
        products:
          catalog.label === "action"
            ? [product("p-action"), product("p-both")]
            : [product("p-both"), product("p-sale")],
      };
    });
    const page = await server.getCatalogPage({ flag: "promotion", pageSize: 48 });
    const sent = vi
      .mocked(readRecords)
      .mock.calls.map(catalogOf)
      .filter((call) => call.includeCategories === false);
    expect(sent).toEqual([
      { pageSize: 48, label: "action", fields: "card", includeCategories: false },
      { pageSize: 48, label: "sale", fields: "card", includeCategories: false },
    ]);
    expect(page.products.map((p) => p.id)).toEqual(["p-action", "p-both", "p-sale"]);
    await server.getCatalogPage({ flag: "new", pageSize: 48 });
    expect(catalogOf(vi.mocked(readRecords).mock.calls.at(-1)!)).toEqual({
      pageSize: 48,
      label: "new",
      fields: "card",
      includeCategories: false,
    });
  });
});
