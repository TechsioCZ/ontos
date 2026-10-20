import { beforeEach, describe, expect, it, vi } from "vitest";
import { readRecords } from "@/ontos/gateway";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/config", () => ({ isOntos: () => true }));
vi.mock("@/ontos/gateway", () => ({ readRecords: vi.fn() }));

// tests/setup-match-media.ts replaces this module for component suites; load the real one here.
const server =
  await vi.importActual<typeof import("@/ontos/catalog-server")>("@/ontos/catalog-server");
const body = {
  revision: 5,
  total: 1,
  page: 1,
  pageSize: 16,
  categories: [
    {
      id: "c1",
      parentId: null,
      slug: "srouby",
      name: "Šrouby",
      position: 1,
      heading: "Nerezové šrouby",
      description: "Krátký popis",
      longDescription: "Velmi dlouhý popis kategorie",
      imageSrc: "/akros/products/product-02.jpg",
      imageAlt: "Šrouby",
    },
  ],
  products: [],
};

beforeEach(() => {
  vi.mocked(readRecords).mockReset();
  vi.mocked(readRecords).mockResolvedValue(body);
});

describe("OntOS catalog server reads", () => {
  it("sends the published storefrontCatalog shape without unset keys", async () => {
    await server.getSnapshot(true, {
      categorySlug: "srouby",
      page: 2,
      pageSize: 24,
      q: "",
      minMinor: undefined,
    });
    expect(readRecords).toHaveBeenCalledWith("merchandise", "records", {
      view: {
        storefront: true,
        storefrontCatalog: { categorySlug: "srouby", page: 2, pageSize: 24 },
      },
    });
  });
  it("caches equal queries briefly and bypasses the cache for fresh reads", async () => {
    await server.getSnapshot(false, { slug: "cache-test", pageSize: 1 });
    await server.getSnapshot(false, { slug: "cache-test", pageSize: 1 });
    expect(readRecords).toHaveBeenCalledTimes(1);
    await server.getSnapshot(true, { slug: "cache-test", pageSize: 1 });
    expect(readRecords).toHaveBeenCalledTimes(2);
    expect(server.CATALOG_CACHE_MS).toBeLessThanOrEqual(15_000);
  });
  it("reads the homepage selection for the layout and strips long category texts", async () => {
    const snapshot = await server.getShellSnapshot();
    expect(vi.mocked(readRecords).mock.calls[0][2]).toEqual({
      view: { storefront: true, storefrontCatalog: { featured: true, pageSize: 16 } },
    });
    expect(snapshot.categories.categories[0]).toEqual({
      id: "c1",
      parentId: null,
      hasChildren: false,
      slug: "srouby",
      name: "Šrouby",
      position: 1,
      imageSrc: "/akros/products/product-02.jpg",
      imageAlt: "Šrouby",
    });
  });
  it("returns page totals for paginated pages", async () => {
    const page = await server.getCatalogPage({ q: "page-test", page: 1, pageSize: 24 });
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 16, products: [] });
    expect(page.model.getCategoryBySlug("srouby")?.longDescription).toBe(
      "Velmi dlouhý popis kategorie",
    );
  });
  it("maps storefront sections to owner labels and merges promotion reads", async () => {
    vi.mocked(readRecords).mockImplementation(async (_v, _r, query) => {
      const label = (query as { view: { storefrontCatalog: { label?: string } } }).view
        .storefrontCatalog.label;
      const product = (id: string) => ({
        id,
        slug: id,
        name: id,
        grossPriceMinor: 121,
        currentPriceMinor: 100,
        stockOnHand: 5,
        minimumQuantity: 1,
      });
      return {
        ...body,
        products:
          label === "action"
            ? [product("p-action"), product("p-both")]
            : [product("p-both"), product("p-sale")],
      };
    });
    const page = await server.getCatalogPage({ flag: "promotion", pageSize: 48 });
    const sent = vi.mocked(readRecords).mock.calls.map((call) => call[2]);
    expect(sent).toEqual([
      { view: { storefront: true, storefrontCatalog: { pageSize: 48, label: "action" } } },
      { view: { storefront: true, storefrontCatalog: { pageSize: 48, label: "sale" } } },
    ]);
    expect(page.products.map((product) => product.id)).toEqual(["p-action", "p-both", "p-sale"]);
    await server.getCatalogPage({ flag: "new", pageSize: 48 });
    expect(vi.mocked(readRecords).mock.calls.at(-1)?.[2]).toEqual({
      view: { storefront: true, storefrontCatalog: { pageSize: 48, label: "new" } },
    });
  });
});
