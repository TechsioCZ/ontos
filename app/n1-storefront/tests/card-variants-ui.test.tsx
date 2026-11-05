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
  it("keeps three real labels plus N and real generic detail links before interaction", () => {
    const html = renderToStaticMarkup(createElement(CardVariants, { locale: "cs", product }));
    expect(html).toContain("8,5 - ML");
    expect(html).toContain("6,5 - XS");
    expect(html).toContain("7 - S");
    expect(html).toContain("+5");
    expect(html.match(/href="\/cs\/produkt\/owner"/gu)).toHaveLength(3);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("?variant=");
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
