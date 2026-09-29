import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProductGrid } from "@/components/product-grid";
import { getProductBySlug, toProductSummary } from "@/mock-storefront/catalog";

describe("ProductGrid", () => {
  it("presents a mixed-unit variant group without inventing an aggregate stock", () => {
    const product = getProductBySlug("profilovana-stresni-krytina-product-35919");

    expect(product).toBeDefined();
    render(<ProductGrid products={[toProductSummary(product!)]} />);

    expect(screen.getByText(/^od 10,36 Kč$/)).toBeDefined();
    expect(screen.getByText("Dostupnost podle varianty")).toBeDefined();
    expect(screen.queryByText(/2[\s ]?929,4\s+ks/)).toBeNull();
  });
});
