import { describe, expect, it } from "vitest";
import { parseCategoryFilters, categoryFilterParams } from "@/ontos/category-filters";

describe("category query", () => {
  it("parses comma-decimal prices to minor units for the OntOS read", () =>
    expect(parseCategoryFilters({ min: "0,50", max: "12", sort: "price-desc" })).toMatchObject({
      minMinor: 50,
      maxMinor: 1200,
      sort: "price-desc",
    }));
  it("does not accept arbitrary permission-like or malformed query values", () => {
    const filters = parseCategoryFilters({
      min: "Infinity",
      max: "-1",
      sort: "admin",
      availability: "all-staff",
    });
    expect(filters).toMatchObject({ minMinor: undefined, maxMinor: undefined, availability: "" });
    expect(categoryFilterParams(filters)).toEqual({});
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
});
