import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CategoryPage from "@/app/kategorie/[slug]/page";
import SearchPage from "@/app/vyhledavani/page";
import { CartProvider } from "@/features/cart/cart-provider";
import * as mockCatalog from "@/mock-storefront/catalog";
import { getCatalogPage, type CatalogPage } from "@/ontos/catalog-server";

vi.mock("@/ontos/config", () => ({ isOntos: () => true }));
vi.mock("@/ontos/catalog-server", async () => {
  const model = await import("@/mock-storefront/catalog");
  return { getCatalog: async () => model, getCatalogPage: vi.fn() };
});
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
  snapshot: {} as CatalogPage["snapshot"],
  model: mockCatalog as unknown as CatalogPage["model"],
  products: mockCatalog.getProductsByCategory("srouby").slice(0, 3),
  total,
  page: 2,
  pageSize: 24,
});

beforeEach(() => vi.mocked(getCatalogPage).mockReset());
afterEach(cleanup);

describe("OntOS category and search pages", () => {
  it("lets OntOS filter, sort and page the category and shows its total", async () => {
    vi.mocked(getCatalogPage).mockResolvedValue(ownerPage(100));
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
    expect(getCatalogPage).toHaveBeenCalledWith({
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
    vi.mocked(getCatalogPage)
      .mockResolvedValueOnce({ ...ownerPage(30), products: [] })
      .mockResolvedValueOnce(ownerPage(30));
    await CategoryPage({
      params: Promise.resolve({ slug: "srouby" }),
      searchParams: Promise.resolve({ page: "9" }),
    });
    expect(vi.mocked(getCatalogPage).mock.calls[1][0]).toMatchObject({
      categorySlug: "srouby",
      page: 2,
    });
  });
  it("shows the Czech filter hint when OntOS finds nothing for active filters", async () => {
    vi.mocked(getCatalogPage).mockResolvedValue({ ...ownerPage(0), products: [] });
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
