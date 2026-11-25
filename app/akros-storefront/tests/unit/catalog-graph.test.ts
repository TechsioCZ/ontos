import { describe, expect, it } from "vitest";
import { createCatalog } from "@/ontos/catalog-model";
import type { CatalogCategory } from "@/ontos/catalog-types";
import { projectCategories } from "@/ontos/catalog-projection";

const category = (id: string, parentId: string | null): CatalogCategory => ({
  id,
  parentId,
  slug: id,
  name: id,
  position: 0,
  hasChildren: false,
});
const products = { products: [], homepageFeaturedProductIds: [] };

describe("catalog graph boundary", () => {
  it("rejects cyclic owner data before breadcrumb traversal can run", () => {
    expect(() =>
      createCatalog(products, {
        categories: [category("a", "b"), category("b", "a")],
      }),
    ).toThrow("Invalid category forest: cycle");
  });
  it("accepts partial projections and preserves actual ancestors", () => {
    const child = category("child", "omitted");
    const model = createCatalog(products, { categories: [child] });
    expect(model.getCategoryTrail(child)).toEqual([child]);
  });
  it("rejects duplicate identities before content merging can conceal them", () => {
    expect(() =>
      projectCategories({
        categories: [category("child", "child"), category("child", "root")],
      }),
    ).toThrow("Invalid category forest: duplicate");
  });
});
