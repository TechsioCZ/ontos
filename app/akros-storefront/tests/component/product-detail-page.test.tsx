import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProductPage from "@/app/produkt/[slug]/page";
import { CartProvider } from "@/features/cart/cart-provider";
import { createCatalog } from "@/ontos/catalog-model";
import { getCatalogPage, type CatalogPage } from "@/ontos/catalog-server";
import type { CatalogProduct } from "@/ontos/catalog-types";
import { fixtureProducts } from "../support/catalog-fixture";

vi.mock("@/ontos/catalog-server", async () => {
  const { fixtureCatalog } = await import("../support/catalog-fixture");
  return {
    getCatalog: async () => fixtureCatalog,
    getCatalogPage: vi.fn<() => Promise<unknown>>(),
  };
});
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
  useRouter: () => ({ push: vi.fn<(href: string) => void>() }),
  useSearchParams: () => new URLSearchParams(),
}));

const withVariants = fixtureProducts.find(
  (candidate) =>
    candidate.detail.variants.length > 2 &&
    candidate.detail.variants.every((variant) => variant.priceMinor > 0),
)!;
const plain: CatalogProduct = {
  ...fixtureProducts.find(
    (candidate) => candidate.detail.variants.length === 0 && candidate.priceMinor > 0,
  )!,
  netWeight: 0.0034,
};
const ownerPage = (product: CatalogProduct): CatalogPage => ({
  model: createCatalog({ products: [product], homepageFeaturedProductIds: [] }, { categories: [] }),
  products: [product],
  total: 1,
  page: 1,
  pageSize: 1,
});
const renderPage = async (
  product: CatalogProduct,
  searchParams: { variant?: string; variantIds?: string } = {},
) => {
  vi.mocked(getCatalogPage).mockResolvedValue(ownerPage(product));
  return render(
    <CartProvider storage={null}>
      {await ProductPage({
        params: Promise.resolve({ slug: product.slug }),
        searchParams: Promise.resolve(searchParams),
      })}
    </CartProvider>,
  );
};

/** The stage readiness probe's purchase check (app/scripts/ops/stage-demo-readiness.mjs). */
const hasProductPurchase = (main: Element) =>
  [...main.querySelectorAll("#product-variants .sf-variant-table__order, .sf-purchase-form")].some(
    (controls) =>
      [...controls.querySelectorAll("input[value]")].some(
        (input) => (input.getAttribute("value") ?? "").trim() !== "",
      ) &&
      [...controls.querySelectorAll("button")].some(
        (button) => (button.textContent ?? "").trim() !== "",
      ),
  );

beforeEach(() => {
  vi.mocked(getCatalogPage).mockReset();
});
afterEach(cleanup);

describe("product detail page", () => {
  it("lists every variant with the markup the stage readiness probe reads", async () => {
    const { container } = await renderPage(withVariants);
    const main = container.querySelector("main")!;
    expect(main.querySelector("h1#product-title")?.textContent).toBe(withVariants.name);
    expect(main.querySelector("#product-variants .sf-variant-table__order")).not.toBeNull();
    expect(hasProductPurchase(main)).toBe(true);
    const table = screen.getByRole("table", { name: "Varianty produktu" });
    expect(within(table).getAllByRole("row")).toHaveLength(withVariants.detail.variants.length + 1);
    expect(screen.getByRole("heading", { name: "Doprava a platba" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Více o dopravě a platbě" }).getAttribute("href")).toBe(
      "/doprava-a-platba",
    );
  });

  it("narrows the table to a shared variant selection and reports a vanished one", async () => {
    const [first] = withVariants.detail.variants;
    await renderPage(withVariants, { variantIds: `${first.id},gone` });
    const table = screen.getByRole("table", { name: "Varianty produktu" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(
      screen.getByText(/Sdílený výběr: 1 variant\. Část sdílených variant již není v katalogu\./),
    ).toBeTruthy();
    cleanup();
    await renderPage(withVariants, { variantIds: "gone" });
    expect(screen.getByText("Sdílené varianty již nejsou v katalogu.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Varianty produktu" })).toBeNull();
  });

  it("shows the source weight and the purchase form of a product without variants", async () => {
    const { container } = await renderPage(plain);
    expect(screen.getByText("Hmotnost")).toBeTruthy();
    expect(screen.getByText("0,0034 kg")).toBeTruthy();
    expect(container.querySelector("main .sf-purchase-form")).not.toBeNull();
    expect(hasProductPurchase(container.querySelector("main")!)).toBe(true);
    expect(screen.getByRole("button", { name: `Uložit ${plain.name} do oblíbených` })).toBeTruthy();
  });

  it("hides the purchase of a product without variants behind a vanished shared selection", async () => {
    const { container } = await renderPage(plain, { variantIds: "gone" });
    expect(screen.getByText("Sdílené varianty již nejsou v katalogu.")).toBeTruthy();
    expect(container.querySelector(".sf-product-detail .sf-purchase-form")).toBeNull();
  });
});
