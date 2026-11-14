import { describe, expect, it } from "effect-rstest";
import { categoryTrail, categoryTree, catalogPage } from "../src/ontos/catalog-navigation";

const categories = [
  { id: "root", name: "Root", parentId: null, slug: "root" },
  { id: "child", name: "Child", parentId: "root", slug: "child" },
  { id: "leaf", name: "Leaf", parentId: "child", slug: "leaf" },
];

describe("owner category navigation", () => {
  it("preserves the real ancestor chain and owner sibling order", () => {
    expect(categoryTrail(categories, "leaf").map((item) => item.id)).toEqual([
      "root",
      "child",
      "leaf",
    ]);
    expect(categoryTree(categories)).toEqual([
      {
        children: [
          { children: [{ children: [], id: "leaf", name: "Leaf" }], id: "child", name: "Child" },
        ],
        id: "root",
        name: "Root",
      },
    ]);
  });
  it("terminates a malformed cycle and does not invent missing parents", () => {
    const cycle = [{ ...categories[0], parentId: "child" }, categories[1]];
    expect(categoryTrail(cycle, "child")).toHaveLength(2);
    expect(categoryTree(cycle)).toEqual([]);
    expect(categoryTrail(categories, "absent")).toEqual([]);
  });
  it.each([undefined, "0", "-1", "1.5", "abc", "9007199254740992", ["2", "3"]])(
    "uses page one for invalid or ambiguous URL input %j",
    (value) => {
      expect(catalogPage(value)).toBe(1);
    },
  );
  it("passes a real requested page through to the owner", () => {
    expect(catalogPage("12")).toBe(12);
  });
});
