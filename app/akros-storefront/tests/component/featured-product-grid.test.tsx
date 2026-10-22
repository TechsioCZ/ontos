import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FeaturedProductGrid } from "@/components/featured-product-grid";
import { getHomepageFeaturedProducts, toProductSummary } from "@/mock-storefront/catalog";

describe("FeaturedProductGrid", () => {
  it("renders homepage recommendations through the standard rich product cards", () => {
    const products = getHomepageFeaturedProducts().map(toProductSummary);

    const { container } = render(<FeaturedProductGrid products={products} />);

    expect(container.firstElementChild?.classList.contains("akros-product-grid")).toBe(false);
    expect(container.firstElementChild?.classList.contains("gap-x-5")).toBe(true);
    expect(container.firstElementChild?.classList.contains("px-4")).toBe(true);

    expect(products).toHaveLength(16);
    expect(screen.getAllByRole("article")).toHaveLength(products.length);
    for (const [index, article] of screen.getAllByRole("article").entries()) {
      const card = within(article);
      expect(card.getByRole("link", { name: "Vybrat variantu" }).getAttribute("href")).toBe(
        `/produkt/${products[index].slug}`,
      );
      expect(card.getByRole("img").getAttribute("loading")).toBe(index < 4 ? "eager" : "lazy");
    }
    expect(screen.getAllByRole("link", { name: "Vybrat variantu" })).toHaveLength(products.length);
    expect(screen.getAllByRole("button", { name: /^Vybrat oblíbené varianty:/ })).toHaveLength(
      products.length,
    );
    expect(screen.queryByText(/^od \d/)).toBeNull();
    expect(screen.getAllByText("Cena dle varianty")).toHaveLength(
      products.filter((product) => product.priceIsFrom).length,
    );
    expect(screen.getByText("Kód produktu: 3tykv021")).toBeDefined();
    expect(screen.getAllByText("Více variant")).toHaveLength(products.length);
  });
});
