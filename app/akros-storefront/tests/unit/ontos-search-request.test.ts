import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/search/route";
import { createCatalog } from "@/ontos/catalog-model";
import { projectProducts } from "@/ontos/catalog-projection";
import { getCatalogPage, type CatalogPage } from "@/ontos/catalog-server";
import { readSearchVariantMatches } from "@/ontos/search-variants";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/catalog-server", () => ({
  getCatalogPage: vi.fn<typeof getCatalogPage>(),
}));
vi.mock("@/ontos/search-variants", () => ({
  readSearchVariantMatches: vi.fn<typeof readSearchVariantMatches>(),
}));

const catalog = projectProducts({ products: [] });
const page: CatalogPage = {
  model: createCatalog(catalog, { categories: [] }),
  products: [],
  total: 0,
  page: 1,
  pageSize: 6,
};
const ask = (body: unknown, locale = "cs") =>
  POST(
    new Request("http://localhost:3070/api/ontos/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-akros-market-locale": locale },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.mocked(getCatalogPage).mockReset();
  vi.mocked(getCatalogPage).mockResolvedValue(page);
  vi.mocked(readSearchVariantMatches).mockReset();
  vi.mocked(readSearchVariantMatches).mockResolvedValue(new Map());
});

afterEach(() => {
  vi.restoreAllMocks();
});

const empty = { items: [], total: 0, categories: [] };

describe("public storefront search query ingress", () => {
  it.each(["šš", "Český šroub", "x".repeat(200)])(
    "forwards a valid query trimmed and never accent-stripped: %s",
    async (query) => {
      const response = await ask({ q: `  ${query}  ` });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(empty);
      expect(getCatalogPage).toHaveBeenCalledExactlyOnceWith({ q: query, page: 1, pageSize: 6 });
      expect(readSearchVariantMatches).toHaveBeenCalledExactlyOnceWith([], query);
    },
  );

  it("cuts text longer than 200 characters to 200 instead of rejecting it", async () => {
    const response = await ask({ q: `  ${"x".repeat(200)}yyy  ` });
    expect(response.status).toBe(200);
    expect(getCatalogPage).toHaveBeenCalledExactlyOnceWith({
      q: "x".repeat(200),
      page: 1,
      pageSize: 6,
    });
  });

  it.each([
    {},
    { q: null },
    { q: 1 },
    { q: [] },
    { q: {} },
    { q: "" },
    { q: " \t\n " },
    { q: "š" },
    { q: " a " },
    [],
    "šroub",
    1,
  ])("answers %j with no results and no owner read, never a 400", async (body) => {
    const response = await ask(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(empty);
    expect(getCatalogPage).not.toHaveBeenCalled();
    expect(readSearchVariantMatches).not.toHaveBeenCalled();
  });
});
