import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Schema, Struct } from "effect";
import ProductPage from "../src/app/[locale]/produkt/[slug]/page";
import { getCatalog } from "../src/ontos/catalog";
import { CatalogResponseSchema, projectCatalog } from "../src/ontos/catalog-model";
import { getDictionary } from "../src/i18n";

rs.mock("../src/ontos/catalog", () => ({ getCatalog: rs.fn() }));

const product = {
  availability: "IN_STOCK",
  categoryId: "shirts",
  grossPriceMinor: 1200,
  id: "current",
  name: "Current owner shirt",
  slug: "current-shirt",
};
const category = { id: "shirts", name: "Shirts", parentId: null, slug: "shirts" };
const catalogOf = (
  products: typeof CatalogResponseSchema.Encoded.products,
  categories: typeof CatalogResponseSchema.Encoded.categories = [category],
) =>
  projectCatalog(
    Schema.decodeUnknownSync(CatalogResponseSchema)({
      categories,
      market: { configured: true, currency: "CZK", marketId: "market" },
      products,
    }),
    [],
  );
const page = async (locale = "cs", variantId?: string | string[]) =>
  renderToStaticMarkup(
    await ProductPage({
      params: Promise.resolve({ locale, slug: product.slug }),
      searchParams: Promise.resolve(variantId === undefined ? {} : { variantId }),
    }),
  );

beforeEach(() => {
  rs.mocked(getCatalog).mockReset();
});

describe("PDP category-backed related products", () => {
  it.each(["cs", "en"])(
    "uses real category results and excludes the current item in %s",
    async (locale) => {
      const others = Array.from({ length: 6 }, (_, index) => ({
        ...product,
        id: `related-${index}`,
        name: `Related owner shirt ${index}`,
        slug: `related-shirt-${index}`,
      }));
      rs.mocked(getCatalog)
        .mockResolvedValueOnce({ catalog: catalogOf([product]), state: "ready" })
        .mockResolvedValueOnce({ catalog: catalogOf([product, ...others]), state: "ready" });
      const html = await page(locale);
      expect(getCatalog).toHaveBeenNthCalledWith(
        2,
        locale,
        JSON.stringify({ categorySlug: category.slug }),
      );
      expect(html).toContain('aria-labelledby="product-related-heading"');
      expect(html).toContain(`href="/${locale}/produkt/related-shirt-0"`);
      expect(html).toContain(`href="/${locale}/produkt/related-shirt-3"`);
      expect(html).not.toContain(`href="/${locale}/produkt/related-shirt-4"`);
      expect(html).not.toContain(`href="/${locale}/produkt/current-shirt"`);
      expect(html).not.toContain(getDictionary(locale).empty);
      expect(html).not.toContain('class="mt-8 flex flex-col gap-8 md:hidden"');
    },
  );

  it.each(["cs", "en"])(
    "does not claim an empty result when the related read fails in %s",
    async (locale) => {
      rs.mocked(getCatalog)
        .mockResolvedValueOnce({ catalog: catalogOf([product]), state: "ready" })
        .mockResolvedValueOnce({ reason: "StorefrontReadUnavailable", state: "unavailable" });
      const html = await page(locale);
      expect(html).toContain(product.name);
      expect(html).toContain(getDictionary(locale).categoryLoadFailed);
      expect(html).not.toContain(getDictionary(locale).empty);
    },
  );

  it("shows empty only after a successful category read with no other product", async () => {
    rs.mocked(getCatalog)
      .mockResolvedValueOnce({ catalog: catalogOf([product]), state: "ready" })
      .mockResolvedValueOnce({ catalog: catalogOf([product]), state: "ready" });
    expect(await page()).toContain(getDictionary("cs").empty);
    expect(getCatalog).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "missing-category"])(
    "does not substitute the general catalog for an unknown category: %s",
    async (categoryId) => {
      rs.mocked(getCatalog).mockResolvedValueOnce({
        catalog: catalogOf([
          categoryId === undefined
            ? Struct.omit(product, ["categoryId"])
            : { ...product, categoryId },
        ]),
        state: "ready",
      });
      const html = await page();
      expect(getCatalog).toHaveBeenCalledTimes(1);
      expect(html).not.toContain('aria-labelledby="product-related-heading"');
      expect(html).not.toContain(getDictionary("cs").empty);
    },
  );

  it("does not perform the optional read for an invalid repeated variant selector", async () => {
    rs.mocked(getCatalog).mockResolvedValueOnce({ catalog: catalogOf([product]), state: "ready" });
    await expect(page("cs", ["first", "second"])).rejects.toThrow(/404/u);
    expect(getCatalog).toHaveBeenCalledTimes(1);
  });
});
