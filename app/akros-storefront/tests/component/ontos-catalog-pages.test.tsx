import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CategoryPage from "@/app/kategorie/[slug]/page";
import SearchPage from "@/app/vyhledavani/page";
import { CartProvider } from "@/features/cart/cart-provider";
import { getCatalogPage, getCategoryListing, type CatalogPage } from "@/ontos/catalog-server";
import type { ProductPage } from "@/ontos/catalog-projection";
import { asCard, fixtureCatalog, fixtureCategoryProducts } from "../support/catalog-fixture";

vi.mock("@/ontos/catalog-server", async () => {
  const { fixtureCatalog } = await import("../support/catalog-fixture");
  return {
    CATEGORY_PAGE_SIZE: 24,
    getCatalog: async () => fixtureCatalog,
    getCatalogPage: vi.fn(),
    getCategoryListing: vi.fn(),
  };
});
// The active-branch navigation is an async server wrapper; shell rendering is covered elsewhere.
vi.mock("@/ontos/category-branch", () => ({
  CategoryBranch: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/storefront-shell", () => ({
  StorefrontShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const ownerPage = (total: number): CatalogPage => ({
  model: fixtureCatalog,
  products: fixtureCategoryProducts("srouby").slice(0, 3).map(asCard),
  total,
  page: 2,
  pageSize: 24,
});

/** A category listing page as `getCategoryListing` returns it (no model: the page takes it from getCatalog). */
const listingPage = (total: number): ProductPage => {
  const { products, page, pageSize } = ownerPage(total);
  return { products, total, page, pageSize, revision: 1, homepageFeaturedProductIds: [] };
};

beforeEach(() => {
  vi.mocked(getCatalogPage).mockReset();
  vi.mocked(getCategoryListing).mockReset();
});
afterEach(cleanup);

describe("OntOS category and search pages", () => {
  it("lets OntOS filter, sort and page the category and shows its total", async () => {
    vi.mocked(getCategoryListing).mockResolvedValue(listingPage(100));
    render(
      <CartProvider storage={null}>
        {await CategoryPage({
          params: Promise.resolve({ slug: "srouby" }),
          searchParams: Promise.resolve({
            page: "2",
            sort: "price-asc",
            min: "10",
            availability: "in-stock",
          }),
        })}
      </CartProvider>,
    );
    expect(getCategoryListing).toHaveBeenCalledWith({
      categorySlug: "srouby",
      page: 2,
      pageSize: 24,
      sort: "price-asc",
      minMinor: 1000,
      availability: "in-stock",
    });
    expect(screen.getAllByRole("heading", { level: 1 })[0].textContent).toBe("Šrouby");
    expect(document.querySelectorAll(".akros-catalog-product-card").length).toBeGreaterThanOrEqual(
      3,
    );
  });
  it("re-reads the last page when the requested page is past the end", async () => {
    vi.mocked(getCategoryListing)
      .mockResolvedValueOnce({ ...listingPage(30), products: [] })
      .mockResolvedValueOnce(listingPage(30));
    await CategoryPage({
      params: Promise.resolve({ slug: "srouby" }),
      searchParams: Promise.resolve({ page: "9" }),
    });
    expect(vi.mocked(getCategoryListing).mock.calls[1][0]).toMatchObject({
      categorySlug: "srouby",
      page: 2,
    });
  });
  it("shows the Czech filter hint when OntOS finds nothing for active filters", async () => {
    vi.mocked(getCategoryListing).mockResolvedValue({ ...listingPage(0), products: [] });
    render(
      <CartProvider storage={null}>
        {await CategoryPage({
          params: Promise.resolve({ slug: "srouby" }),
          searchParams: Promise.resolve({ q: "neexistuje" }),
        })}
      </CartProvider>,
    );
    expect(
      screen.getByText("Nenalezeny žádné produkty. Upravte nebo vymažte filtry."),
    ).toBeDefined();
  });
  it("searches through OntOS and skips the read for an empty query", async () => {
    vi.mocked(getCatalogPage).mockResolvedValue(ownerPage(100));
    render(
      <CartProvider storage={null}>
        {await SearchPage({ searchParams: Promise.resolve({ q: " šroub ", page: "2" }) })}
      </CartProvider>,
    );
    expect(getCatalogPage).toHaveBeenCalledWith({ q: "šroub", page: 2, pageSize: 24 });
    expect(document.querySelectorAll(".akros-catalog-product-card").length).toBeGreaterThanOrEqual(
      3,
    );
    vi.mocked(getCatalogPage).mockClear();
    await SearchPage({ searchParams: Promise.resolve({ q: "  " }) });
    expect(getCatalogPage).not.toHaveBeenCalled();
  });
});
