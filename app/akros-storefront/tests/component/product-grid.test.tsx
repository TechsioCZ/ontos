import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ProductGrid } from "@/components/product-grid";
import {
  getActionProducts,
  getProductBySlug,
  getProducts,
  getRecommendedProducts,
  getSaleProducts,
  toProductSummary,
} from "@/mock-storefront/catalog";

describe("ProductGrid", () => {
  afterEach(cleanup);

  it("presents a mixed-unit variant group without inventing aggregate stock", () => {
    const product = getProductBySlug("profilovana-stresni-krytina-product-35919");

    expect(product).toBeDefined();
    const { container } = render(<ProductGrid products={[toProductSummary(product!)]} />);
    expect(container.firstElementChild?.className).toBe("akros-product-grid");

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

  it("shows recommendation tags only when the source marks the product as recommended", () => {
    const product = getRecommendedProducts().find((item) => !item.isSale && !item.isAction)!;

    render(<ProductGrid action="detail" products={[toProductSummary(product)]} />);

    expect(screen.getByText("Doporučujeme")).toBeDefined();
    expect(screen.queryByText("Doprodej")).toBeNull();
    expect(screen.queryByText("Akce")).toBeNull();
  });

  it("shows source-backed clearance and clarifies when only selected variants are on sale", () => {
    const product = getSaleProducts()[0];

    expect(product.detail.variants.filter((variant) => variant.isSale)).toHaveLength(1);
    expect(product.detail.variants.length).toBeGreaterThan(1);
    render(<ProductGrid action="detail" products={[toProductSummary(product)]} />);

    const badge = screen.getByText("Doprodej");
    expect(badge.getAttribute("title")).toContain("vybraných variant");
    expect(badge.closest("a")?.getAttribute("href")).toBe(`/produkt/${product.slug}`);
    expect(screen.queryByText("Akce")).toBeNull();
  });

  it("shows an action tag for source-backed action products", () => {
    const product = getActionProducts().find((item) => !item.isSale && !item.isRecommended)!;

    render(<ProductGrid action="detail" products={[toProductSummary(product)]} />);

    expect(screen.getByText("Akce")).toBeDefined();
    expect(screen.queryByText("Doprodej")).toBeNull();
  });

  it("does not invent recommendation, video or novelty tags from fallback selections", () => {
    const product = getProducts().find(
      (item) => item.isNew && !item.isRecommended && !item.isSale && !item.isAction,
    )!;
    const { container } = render(
      <ProductGrid action="detail" products={[toProductSummary(product)]} />,
    );

    expect(container.querySelector("[data-akros-product-tags]")).toBeNull();
    expect(screen.queryByText("Novinka")).toBeNull();
    expect(screen.queryByText("Video")).toBeNull();
  });

  it("keeps recommendation and clearance tags without duplicating the action tag", () => {
    const product = {
      ...toProductSummary(getSaleProducts()[0]),
      isAction: true,
      isRecommended: true,
    };
    const { container } = render(<ProductGrid action="detail" products={[product]} />);

    expect(screen.getByText("Doporučujeme")).toBeDefined();
    expect(screen.getByText("Doprodej")).toBeDefined();
    expect(screen.queryByText("Akce")).toBeNull();
    expect(container.querySelector("[data-akros-product-tags]")?.children).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Vybrat variantu" }).getAttribute("href")).toBe(
      `/produkt/${product.slug}`,
    );
  });
});
