import { rs } from "@rstest/core";
import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "effect-rstest";
import { getCatalog } from "../src/ontos/catalog";
import { projectCatalog } from "../src/ontos/catalog-model";
import { readSearchSuggestions } from "../src/ontos/search-suggestions";
import { SearchSuggestionsResponse } from "../src/ontos/search-contract";
import { GET } from "../src/app/api/search-suggestions/route";

rs.mock("../src/ontos/catalog", () => ({ getCatalog: rs.fn() }));

const read = rs.mocked(getCatalog);
const catalog = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "test-market" },
    products: Array.from({ length: 10 }, (_, index) => ({
      id: `owner-${index}`,
      name: `Owner product ${index}`,
      slug: `owner-${index}`,
    })),
  },
  [],
);

describe("search suggestions read boundary", () => {
  beforeEach(() => {
    read.mockReset();
  });

  it("does not call the owner for a blank query", async () => {
    expect(await readSearchSuggestions("cs", "   ")).toEqual({ state: "idle" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", "helmet"],
    ["cs", "x".repeat(201)],
  ])("rejects invalid locale or unbounded query before owner access: %s", async (locale, query) => {
    expect(await readSearchSuggestions(locale, query)).toEqual({ state: "unavailable" });
    expect(read).not.toHaveBeenCalled();
  });

  it("uses the same owner query as the results page and bounds only the preview", async () => {
    read.mockResolvedValue({ catalog, state: "ready" });
    expect(await readSearchSuggestions("cs", "  helmet  ")).toEqual({
      products: catalog.products.slice(0, 8),
      state: "ready",
    });
    expect(read).toHaveBeenCalledExactlyOnceWith("cs", JSON.stringify({ q: "helmet" }));
  });

  it("keeps a successful empty catalogue distinct from an unavailable read", async () => {
    read.mockResolvedValue({ catalog: { ...catalog, products: [] }, state: "ready" });
    expect(await readSearchSuggestions("cs", "absent")).toEqual({ products: [], state: "ready" });
    read.mockResolvedValue({ reason: "StorefrontReadUnavailable", state: "unavailable" });
    expect(await readSearchSuggestions("cs", "helmet")).toEqual({ state: "unavailable" });
  });

  it("does not present an unconfigured market as a successful empty result", async () => {
    read.mockResolvedValue({ catalog: { ...catalog, configured: false }, state: "ready" });
    expect(await readSearchSuggestions("en", "helmet")).toEqual({ state: "unavailable" });
  });

  it("serves an uncached GET preview through the existing owner query", async () => {
    read.mockResolvedValue({ catalog, state: "ready" });
    const response = await GET(
      new Request("https://shop.example/api/search-suggestions?locale=cs&q=helmet"),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      products: catalog.products.slice(0, 8),
      state: "ready",
    });
    expect(read).toHaveBeenCalledExactlyOnceWith("cs", JSON.stringify({ q: "helmet" }));
  });

  it("rejects an invalid GET locale without accessing owner data", async () => {
    const response = await GET(
      new Request("https://shop.example/api/search-suggestions?locale=invalid&q=helmet"),
    );
    expect(await response.json()).toEqual({ state: "unavailable" });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects oversized or unknown transport results while accepting a real empty result", () => {
    const valid = Schema.is(SearchSuggestionsResponse);
    expect(valid({ products: [], state: "ready" })).toBe(true);
    expect(valid({ products: catalog.products, state: "ready" })).toBe(false);
    expect(valid({ state: "unexpected" })).toBe(false);
  });
});
