import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProductPage, { generateMetadata } from "@/app/produkt/[slug]/page";
import NewsPage from "@/app/novinky-a-akce/page";
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

const product = mockCatalog
  .getProducts()
  .find((candidate) => candidate.detail.variants.length > 1)!;
const ownerPage: CatalogPage = {
  snapshot: {} as CatalogPage["snapshot"],
  model: mockCatalog as unknown as CatalogPage["model"],
  products: [product],
  total: 1,
  page: 1,
  pageSize: 1,
};

beforeEach(() => {
  vi.mocked(getCatalogPage).mockReset();
  vi.mocked(getCatalogPage).mockResolvedValue(ownerPage);
});
afterEach(cleanup);

describe("OntOS product and news pages", () => {
  it("reads exactly one product by slug from OntOS", async () => {
    render(
      <CartProvider storage={null}>
        {await ProductPage({
          params: Promise.resolve({ slug: product.slug }),
          searchParams: Promise.resolve({}),
        })}
      </CartProvider>,
    );
    expect(getCatalogPage).toHaveBeenCalledWith({ slug: product.slug, pageSize: 1 });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(product.name);
    expect(
      await generateMetadata({
        params: Promise.resolve({ slug: product.slug }),
        searchParams: Promise.resolve({}),
      }),
    ).toEqual({
      title: product.name,
    });
  });
  it("reads the new and promotion sections as flagged OntOS pages", async () => {
    render(<CartProvider storage={null}>{await NewsPage()}</CartProvider>);
    expect(getCatalogPage).toHaveBeenCalledWith({ flag: "new", pageSize: 48 });
    expect(getCatalogPage).toHaveBeenCalledWith({ flag: "promotion", pageSize: 48 });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Novinky a akce");
  });
  it("keeps the page up when a flagged read fails", async () => {
    vi.mocked(getCatalogPage).mockRejectedValue(new Error("HTTP 400"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<CartProvider storage={null}>{await NewsPage()}</CartProvider>);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Novinky a akce");
  });
});
