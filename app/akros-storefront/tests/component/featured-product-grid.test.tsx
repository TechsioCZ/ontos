import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FeaturedProductGrid } from "@/components/featured-product-grid";
import { getHomepageFeaturedProducts, toProductSummary } from "@/mock-storefront/catalog";

describe("FeaturedProductGrid", () => {
  it("renders homepage recommendations through the standard rich product cards", () => {
    const products = getHomepageFeaturedProducts().map(toProductSummary);

    render(<FeaturedProductGrid products={products} />);

    expect(products).toHaveLength(4);
    expect(screen.getAllByRole("article")).toHaveLength(products.length);
    expect(screen.getAllByRole("link", { name: "Vybrat variantu" })).toHaveLength(products.length);
    expect(screen.getAllByRole("link", { name: "Zobrazit oblíbené produkty" })).toHaveLength(
      products.length,
    );
    expect(screen.getByText(/^od 0,08 Kč$/)).toBeDefined();
    expect(screen.getByText("Kód produktu: 3tykv021")).toBeDefined();
    expect(screen.getAllByText("Více variant")).toHaveLength(products.length);
  });
});
