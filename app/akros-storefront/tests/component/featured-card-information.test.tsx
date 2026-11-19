import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FeaturedProductGrid } from "@/components/featured-product-grid";
import { fixtureCatalog } from "../support/catalog-fixture";
import { renderStorefront } from "../support/storefront";

const products = fixtureCatalog
  .getProducts()
  .map(fixtureCatalog.toProductSummary)
  .filter((product) => product.hasVariants && product.priceIsFrom)
  .slice(0, 6)
  .map((product, index) => ({
    ...product,
    description: index === 0 ? "   " : product.description,
  }));

function renderFeatured() {
  renderStorefront(<FeaturedProductGrid products={products} />);
  return screen.getAllByRole("article");
}

afterEach(cleanup);

describe("Featured card information", () => {
  it("renders every supplied product as an identifiable article in input order", () => {
    const cards = renderFeatured();

    expect(cards).toHaveLength(products.length);
    products.forEach((product, index) => {
      expect(within(cards[index]).getAllByRole("link", { name: product.name })).toHaveLength(2);
    });
  });

  it("offers each featured group its own choose-variant destination", () => {
    const cards = renderFeatured();

    products.forEach((product, index) => {
      expect(
        within(cards[index]).getByRole("link", { name: "Vybrat variantu" }).getAttribute("href"),
      ).toBe(`/cs/produkt/${product.slug}`);
    });
  });

  it("loads the first four featured images eagerly and subsequent images lazily", () => {
    const cards = renderFeatured();

    expect(cards.map((card) => within(card).getByRole("img").getAttribute("loading"))).toEqual([
      "eager",
      "eager",
      "eager",
      "eager",
      "lazy",
      "lazy",
    ]);
  });

  it("exposes a favourite-variant chooser on every featured group", () => {
    const cards = renderFeatured();

    products.forEach((product, index) => {
      expect(
        within(cards[index])
          .getByRole("button", {
            name: (name) =>
              name.startsWith("Vybrat oblíbené varianty:") && name.includes(product.name),
          })
          .getAttribute("aria-haspopup"),
      ).toBe("dialog");
    });
  });

  it("shows a variant-price prompt on every multi-variant card instead of a from-price", () => {
    const cards = renderFeatured();

    for (const card of cards) {
      expect(within(card).getByText("Cena dle varianty")).toBeDefined();
      expect(within(card).queryByText(/^od\s/)).toBeNull();
      expect(within(card).queryByText(/\d[\d\s,.]*Kč/)).toBeNull();
    }
    expect(screen.getAllByText("Cena dle varianty")).toHaveLength(products.length);
  });

  it("uses the product SKU as supporting information when its description is blank", () => {
    const [card] = renderFeatured();

    expect(within(card).getByText(`Kód produktu: ${products[0].sku}`)).toBeDefined();
  });

  it("communicates multiple variants on every featured group", () => {
    const cards = renderFeatured();

    for (const card of cards) expect(within(card).getByText("Více variant")).toBeDefined();
    expect(screen.getAllByText("Více variant")).toHaveLength(products.length);
  });
});
