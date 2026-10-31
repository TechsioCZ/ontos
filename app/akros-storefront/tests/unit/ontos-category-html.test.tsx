// @vitest-environment node
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import CategoryPage from "@/app/kategorie/[slug]/page";
import { CartProvider } from "@/features/cart/cart-provider";
import { getCatalog, getCategoryListing } from "@/ontos/catalog-server";
import { createCatalog } from "@/ontos/catalog-model";
import {
  asCard,
  fixtureCatalog,
  fixtureCategories,
  fixtureProducts,
  fixtureCategoryProducts,
} from "../support/catalog-fixture";
vi.mock("@/ontos/catalog-server", () => ({
  CATEGORY_PAGE_SIZE: 24,
  getCatalog: vi.fn<typeof getCatalog>(),
  getCategoryListing: vi.fn<typeof getCategoryListing>(),
}));
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
  useRouter: () => ({ push: vi.fn<(url: string) => void>() }),
  useSearchParams: () => new URLSearchParams(),
}));
it("renders byte-identical category HTML with cached navigation plus compact active content", async () => {
  const active = fixtureCategories.find((category) => category.slug === "srouby")!;
  const full = fixtureCategories.map(
    ({ heading, longDescription, description, imageSrc, imageAlt, ...node }) => ({
      ...node,
      ...(node.id === active.id ? { heading, longDescription } : {}),
      ...(node.parentId === null || node.id === active.id || node.parentId === active.id
        ? { description, imageSrc, imageAlt }
        : {}),
    }),
  );
  const compact = full.filter((node) => node.id === active.id || node.parentId === active.id);
  const navigation = full.map(
    ({ heading: _h, longDescription: _l, description, imageSrc, imageAlt, ...node }) => ({
      ...node,
      ...(node.parentId === null ? { description, imageSrc, imageAlt } : {}),
    }),
  );
  const contentById = new Map(compact.map((node) => [node.id, node]));
  const merged = navigation.map((node) => contentById.get(node.id) ?? node);
  const data = {
    products: fixtureProducts,
    homepageFeaturedProductIds: fixtureCatalog
      .getHomepageFeaturedProducts()
      .map((product) => product.id),
  };
  vi.mocked(getCatalog)
    .mockResolvedValueOnce(createCatalog(data, { categories: full }))
    .mockResolvedValueOnce(createCatalog(data, { categories: merged }));
  vi.mocked(getCategoryListing).mockResolvedValue({
    products: fixtureCategoryProducts(active.slug).slice(0, 3).map(asCard),
    total: 30,
    page: 1,
    pageSize: 24,
    revision: 1,
    homepageFeaturedProductIds: [],
  });
  const html = async () =>
    renderToStaticMarkup(
      <CartProvider storage={null}>
        {await CategoryPage({
          params: Promise.resolve({ slug: active.slug }),
          searchParams: Promise.resolve({}),
        })}
      </CartProvider>,
    );
  const before = await html();
  const after = await html();
  expect(after).toBe(before);
  expect(after).toContain("Šrouby");
  expect(merged.find((node) => node.id === active.id)).toEqual(
    full.find((node) => node.id === active.id),
  );
  expect(compact.length).toBeLessThan(full.length);
});
