import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProductGrid } from "@/components/product-grid";
import { getProductBySlug, toProductSummary } from "@/mock-storefront/catalog";

describe("ProductGrid", () => {
  it("presents a mixed-unit variant group without inventing aggregate stock", () => {
    const product = getProductBySlug("profilovana-stresni-krytina-product-35919");

    expect(product).toBeDefined();
    render(<ProductGrid products={[toProductSummary(product!)]} />);

    expect(screen.getByText(/^od 10,36 Kč$/)).toBeDefined();
    expect(screen.getByText("Skladem")).toBeDefined();
    expect(screen.getByText("Více variant")).toBeDefined();
    expect(screen.getByRole("link", { name: "Vybrat variantu" }).getAttribute("href")).toBe(
      `/produkt/${product!.slug}`,
    );
    expect(
      screen.getByRole("link", { name: "Zobrazit oblíbené produkty" }).getAttribute("href"),
    ).toBe("/oblibene");
    expect(screen.queryByText(/2[\s\u00a0]?929,4\s+ks/)).toBeNull();
  });
});
