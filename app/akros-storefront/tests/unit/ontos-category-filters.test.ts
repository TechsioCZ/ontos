import { describe, expect, it } from "vitest";
import {
  parseCategoryFilters,
  filterCategoryProducts,
  categoryFilterParams,
} from "@/ontos/category-filters";
import type { CatalogProduct } from "@/mock-storefront/types";
const product = (
  id: string,
  name: string,
  priceMinor: number,
  stockCount = 500,
  variants: CatalogProduct["detail"]["variants"] = [],
): CatalogProduct =>
  ({
    id,
    name,
    priceMinor,
    stockCount,
    sku: id,
    minimumQuantity: 100,
    detail: { variants },
  }) as CatalogProduct;
const products = [
  product("z", "Železo", 500),
  product("a", "Adaptér", 1000),
  product("s", "Šroub", 150, 0),
];
const ids = (query: Parameters<typeof parseCategoryFilters>[0]) =>
  filterCategoryProducts(products, parseCategoryFilters(query)).map((p) => p.id);
describe("category query", () => {
  it("uses Czech name order by default without mutating catalog", () => {
    expect(ids({})).toEqual(["a", "s", "z"]);
    expect(products[0].id).toBe("z");
  });
  it("combines comma-decimal price, availability and name filters", () =>
    expect(ids({ q: "zelez", min: "4,50", max: "5.00", availability: "in-stock" })).toEqual(["z"]));
  it("sorts price ascending and descending", () => {
    expect(ids({ sort: "price-asc" })).toEqual(["s", "z", "a"]);
    expect(ids({ sort: "price-desc" })).toEqual(["a", "z", "s"]);
  });
  it("filters unavailable and impossible ranges deterministically", () => {
    expect(ids({ availability: "out-of-stock" })).toEqual(["s"]);
    expect(ids({ min: "100", max: "1" })).toEqual([]);
  });
  it("does not accept arbitrary permission-like or malformed query values", () => {
    const filters = parseCategoryFilters({
      min: "Infinity",
      max: "-1",
      sort: "admin",
      availability: "all-staff",
    });
    expect(categoryFilterParams(filters)).toEqual({});
    expect(ids({ min: "Infinity", max: "-1" })).toEqual(["a", "s", "z"]);
  });
  it("retains filter URL values without page state", () =>
    expect(
      categoryFilterParams(
        parseCategoryFilters({
          q: "DIN",
          min: "0,50",
          sort: "price-asc",
          availability: "in-stock",
          page: "5",
        }),
      ),
    ).toEqual({ q: "DIN", min: "0,50", sort: "price-asc", availability: "in-stock" }));
  it("requires at least a legal minimum in one variant for availability", () => {
    const variants = [
      { sku: "sku-42", stockCount: 10, minimumQuantity: 20 },
    ] as CatalogProduct["detail"]["variants"];
    const grouped = product("g", "Skupina", 100, 999, variants);
    expect(
      filterCategoryProducts([grouped], parseCategoryFilters({ availability: "in-stock" })),
    ).toEqual([]);
    expect(filterCategoryProducts([grouped], parseCategoryFilters({ q: "sku-42" }))).toEqual([
      grouped,
    ]);
  });
});
