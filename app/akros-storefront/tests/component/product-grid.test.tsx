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

  it.each(["catalog", "featured"] as const)(
    "marks the %s grid for compact mobile styling without duplicating cards",
    (columns) => {
      const product = toProductSummary(
        getProductBySlug("profilovana-stresni-krytina-product-35919")!,
      );
      const { container } = render(<ProductGrid columns={columns} products={[product]} />);

      expect(container.firstElementChild?.getAttribute("data-akros-product-listing")).toBe(columns);
      expect(screen.getAllByRole("article")).toHaveLength(1);
      expect(screen.getAllByRole("link", { name: "Vybrat variantu" })).toHaveLength(1);
      expect(screen.getByRole("img").getAttribute("sizes")).toContain("max-width: 359px");
    },
  );

  it.each(["checkout", "related"] as const)(
    "keeps the %s cards outside the mobile listing overrides",
    (columns) => {
      const product = toProductSummary(
        getProductBySlug("profilovana-stresni-krytina-product-35919")!,
      );
      const { container } = render(<ProductGrid columns={columns} products={[product]} />);

      expect(container.firstElementChild?.hasAttribute("data-akros-product-listing")).toBe(false);
      expect(screen.getByRole("img").getAttribute("sizes")).toContain("max-width: 430px");
    },
  );

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

  it("shows an explicit comparison price next to the current price and its discount", () => {
    const product = {
      ...toProductSummary(getActionProducts()[0]),
      priceMinor: 254,
      originalPriceMinor: 330,
      priceIsFrom: false,
    };
    const { container } = render(<ProductGrid action="detail" products={[product]} />);

    expect(screen.getByText("-23%")).toBeDefined();
    expect(screen.getByText("2,54 Kč")).toBeDefined();
    expect(container.querySelector("del")?.textContent?.replaceAll("\u00a0", " ")).toContain(
      "3,30 Kč",
    );
  });

  it.each([254, 253, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not show a discount for an invalid or non-reduced comparison price %s",
    (originalPriceMinor) => {
      const product = {
        ...toProductSummary(getActionProducts()[0]),
        priceMinor: 254,
        originalPriceMinor,
        priceIsFrom: false,
      };
      const { container } = render(<ProductGrid action="detail" products={[product]} />);

      expect(container.querySelector("del")).toBeNull();
      expect(screen.queryByText(/^-\d+%$/)).toBeNull();
    },
  );

  it("does not compare a group-level from price with a potentially different variant", () => {
    const product = {
      ...toProductSummary(getActionProducts()[0]),
      priceMinor: 254,
      originalPriceMinor: 330,
      priceIsFrom: true,
    };
    const { container } = render(<ProductGrid action="detail" products={[product]} />);

    expect(screen.getByText("od 2,54 Kč")).toBeDefined();
    expect(container.querySelector("del")).toBeNull();
    expect(screen.queryByText("-23%")).toBeNull();
  });
});
