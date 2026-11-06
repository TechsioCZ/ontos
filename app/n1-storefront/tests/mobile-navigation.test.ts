import { describe, expect, it } from "@rstest/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MobileCategoryLinks } from "../src/features/mobile-navigation";
import { categoryTree } from "../src/ontos/catalog-navigation";

describe("mobile owner category navigation", () => {
  const categories = [
    { id: "root", name: "Owner root", parentId: null, slug: "root" },
    { id: "child", name: "Owner child", parentId: "root", slug: "child / a" },
    { id: "leaf", name: "Owner leaf", parentId: "child", slug: "leaf" },
  ];
  it("shows owner child destinations without adding a repeated parent link", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileCategoryLinks, {
        destinations: new Map(categories.map((item) => [item.id, item.slug])),
        locale: "cs",
        nodes: categoryTree(categories),
        onNavigate: () => {},
      }),
    );
    expect(markup).not.toContain('href="/cs/kategorie/root"');
    expect(markup).toContain('href="/cs/kategorie/child%20%2F%20a"');
    expect(markup).toContain('href="/cs/kategorie/leaf"');
    expect(markup).toContain("Owner leaf");
    expect(markup).toContain('data-scope="accordion"');
    expect(markup).not.toContain('href="#"');
  });
  it("does not invent a destination when an owner mapping is absent", () => {
    const markup = renderToStaticMarkup(
      createElement(MobileCategoryLinks, {
        destinations: new Map(),
        locale: "en",
        nodes: categoryTree(categories),
        onNavigate: () => {},
      }),
    );
    expect(markup).not.toContain("href=");
  });
});
