import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProductPage, { generateMetadata } from "@/app/produkt/[slug]/page";
import NewsPage from "@/app/novinky-a-akce/page";
import { CartProvider } from "@/features/cart/cart-provider";
import { createCatalog } from "@/ontos/catalog-model";
import { getCatalogPage, type CatalogPage } from "@/ontos/catalog-server";
import { asCard, fixtureCatalog, fixtureProducts } from "../support/catalog-fixture";

vi.mock("@/ontos/catalog-server", async () => {
  const { fixtureCatalog } = await import("../support/catalog-fixture");
  return { getCatalog: async () => fixtureCatalog, getCatalogPage: vi.fn() };
});
// The active-branch navigation is an async server wrapper; shell rendering is covered elsewhere.
vi.mock("@/ontos/category-branch", () => ({
  CategoryBranch: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/storefront-shell", () => ({
  StorefrontShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  StorefrontWideShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const product = fixtureProducts.find((candidate) => candidate.detail.variants.length > 1)!;
const ownerPage: CatalogPage = {
  model: fixtureCatalog,
  products: [product],
  total: 1,
  page: 1,
  pageSize: 1,
};

const createCardPage = (products: CatalogPage["products"]): CatalogPage => ({
  model: createCatalog({ products, homepageFeaturedProductIds: [] }, { categories: [] }),
  products,
  total: products.length,
  page: 1,
  pageSize: products.length,
});

beforeEach(() => {
  vi.mocked(getCatalogPage).mockReset();
  vi.mocked(getCatalogPage).mockResolvedValue(ownerPage);
});
afterEach(cleanup);

describe("OntOS product and news pages", () => {
  it("reads exactly one product by slug from OntOS", async () => {
    const { container } = render(
      <CartProvider storage={null}>
        {await ProductPage({
          params: Promise.resolve({ slug: product.slug }),
          searchParams: Promise.resolve({}),
        })}
      </CartProvider>,
    );
    expect(getCatalogPage).toHaveBeenCalledWith(
      { slug: product.slug, pageSize: 1 },
      { fields: "full" },
    );
    const detail = container.querySelector<HTMLElement>(".akros-product-detail")!;
    expect(within(detail).getByRole("heading", { level: 1 }).textContent).toBe(product.name);
    const printSheet = screen.getByRole("region", { name: "Produktový list pro tisk" });
    expect(within(printSheet).getByRole("heading", { level: 1 }).textContent).toBe(product.name);
    expect(within(printSheet).getByText(`Kód produktu: ${product.sku}`)).toBeTruthy();
    expect(within(printSheet).getByText(/^Počet variant:/).textContent).toContain(
      String(product.detail.variants.length),
    );
    expect(within(printSheet).queryByText(/^Cena s DPH:/)).toBeNull();
    expect(
      await generateMetadata({
        params: Promise.resolve({ slug: product.slug }),
        searchParams: Promise.resolve({}),
      }),
    ).toEqual({
      title: product.name,
    });
  });
  it("reads the new and promotion sections as flagged OntOS card pages", async () => {
    const sale = fixtureProducts
      .filter((candidate) => candidate.isSale && candidate.stockCount >= candidate.minimumQuantity)
      .map(asCard);
    const cards = createCardPage(sale);
    vi.mocked(getCatalogPage).mockResolvedValue(cards);
    const { container } = render(<CartProvider storage={null}>{await NewsPage()}</CartProvider>);
    expect(getCatalogPage).toHaveBeenCalledWith({ flag: "new", pageSize: 48 });
    expect(getCatalogPage).toHaveBeenCalledWith({ flag: "promotion", pageSize: 48 });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Novinky a akce");
    expect(container.querySelectorAll(".akros-catalog-product-card").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Doprodej").length).toBeGreaterThan(0);
  });
  it("keeps the page up when a flagged read fails", async () => {
    vi.mocked(getCatalogPage).mockRejectedValue(new Error("HTTP 400"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<CartProvider storage={null}>{await NewsPage()}</CartProvider>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Novinky a akce");
  });
});
