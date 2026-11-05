import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "@rstest/core";
import { CardVariants } from "../src/features/card-variants";
import type { ProductCardModel } from "../src/ontos/catalog-model";

const product: ProductCardModel = {
  currency: "CZK",
  description: "",
  id: "owner",
  image: null,
  name: "Owner product",
  priceFrom: false,
  priceMinor: 100,
  sku: "OWNER",
  slug: "owner",
  stock: "available",
  variantCount: 8,
  variantPreview: [
    { id: "first", name: "8,5 - ML" },
    { id: "second", name: "6,5 - XS" },
    { id: "third", name: "7 - S" },
  ],
};
describe("Figma card preview", () => {
  it("keeps three real labels plus N and links each size to its actual owner variant", () => {
    const html = renderToStaticMarkup(createElement(CardVariants, { locale: "cs", product }));
    expect(html).toContain("8,5 - ML");
    expect(html).toContain("6,5 - XS");
    expect(html).toContain("7 - S");
    expect(html).toContain("+5");
    for (const variant of product.variantPreview ?? []) {
      expect(html).toContain(`/cs/produkt/owner?variantId=${variant.id}`);
    }
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("?variant=");
  });
  it("encodes genuine variant IDs without changing locale or interpreting query characters", () => {
    const html = renderToStaticMarkup(
      createElement(CardVariants, {
        locale: "en",
        product: {
          ...product,
          slug: "owner / product",
          variantPreview: [{ id: "size + &?/#", name: "M" }],
        },
      }),
    );
    expect(html).toContain(
      'href="/en/produkt/owner%20%2F%20product?variantId=size+%2B+%26%3F%2F%23"',
    );
  });
  it("does not offer expansion or fabricate labels if native preview is absent", () => {
    const html = renderToStaticMarkup(
      createElement(CardVariants, { locale: "cs", product: { ...product, variantPreview: [] } }),
    );
    expect(html).not.toContain("+8");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("href=");
  });
});
