import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/ontos/product-variants/[slug]/route";
import { readProducts } from "@/ontos/catalog-server";
import type { CatalogProduct } from "@/ontos/catalog-types";
import { fixtureProducts } from "../support/catalog-fixture";

vi.mock("@/ontos/catalog-server", () => ({
  readProducts: vi.fn<typeof import("@/ontos/catalog-server").readProducts>(),
}));

const withVariants = fixtureProducts.find((product) => product.detail.variants.length > 1)!;
const plain: CatalogProduct = {
  ...fixtureProducts.find((product) => product.detail.variants.length === 0)!,
  netWeight: 0.25,
};
const page = (products: CatalogProduct[]) => ({
  revision: 1,
  total: products.length,
  page: 1,
  pageSize: 1,
  products,
  homepageFeaturedProductIds: [],
});
const call = (slug: string) =>
  GET(new Request(`https://shop.test/api/ontos/product-variants/${slug}`), {
    params: Promise.resolve({ slug }),
  });

beforeEach(() => {
  vi.mocked(readProducts).mockReset();
});

describe("GET /api/ontos/product-variants/[slug]", () => {
  it("reads the product's full OntOS record and returns its card and variants", async () => {
    vi.mocked(readProducts).mockResolvedValue(page([withVariants]));
    const response = await call(withVariants.slug);
    expect(readProducts).toHaveBeenCalledWith({ slug: withVariants.slug, pageSize: 1 }, "full");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.product).toMatchObject({ id: withVariants.id, hasVariants: true });
    expect(body.variants.map((variant: { id: string }) => variant.id)).toEqual(
      withVariants.detail.variants.map((variant) => variant.id),
    );
  });

  it("presents a product without variants as its own single concrete item", async () => {
    vi.mocked(readProducts).mockResolvedValue(page([plain]));
    const body = await (await call(plain.slug)).json();
    expect(body.variants).toEqual([
      expect.objectContaining({
        id: plain.id,
        sku: plain.sku,
        priceMinor: plain.priceMinor,
        sourceNetWeight: 0.25,
      }),
    ]);
  });

  it("answers 404 for an unknown product and 503 when OntOS fails", async () => {
    vi.mocked(readProducts).mockResolvedValue(page([]));
    expect((await call("missing")).status).toBe(404);
    vi.mocked(readProducts).mockImplementation(async () => {
      throw new Error("down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("missing")).status).toBe(503);
  });
});
