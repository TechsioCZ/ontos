import { describe, expect, it } from "effect-rstest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getDictionary } from "../src/i18n";
import { projectCatalog } from "../src/ontos/catalog-model";
import { selectProductDetail } from "../src/features/product-selection";
import { ProductView } from "../src/features/product-view";

const {
  details: [product],
} = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "owner-market" },
    products: [
      {
        availability: "IN_STOCK",
        currency: "CZK",
        gallery: ["https://media.example/front.png", "https://media.example/back.png"],
        grossPriceMinor: 90_000,
        id: "product",
        minimumQuantity: 1,
        name: "Owner product",
        parameters: [{ label: "Owner parameter", unit: "", value: "Owner value" }],
        slug: "owner",
        stockTracked: true,
        unit: "piece",
        variantRecords: [
          {
            active: true,
            attributes: "",
            availability: "OUT_OF_STOCK",
            grossPriceMinor: 45_000,
            id: "variant",
            imageSrc: "https://media.example/back.png",
            minimumQuantity: 2,
            name: "Variant",
            sku: "V1",
            stockOnHand: 0,
            unit: "package",
          },
        ],
        variantSummary: { count: 1, minGrossPriceMinor: 45_000, stockOnHand: 0 },
      },
    ],
  },
  ["media.example"],
);

describe("real product variant presentation", () => {
  it("requests a variant before showing quantity controls or claiming availability", () => {
    const d = getDictionary("cs");
    const html = renderToStaticMarkup(
      createElement(ProductView, { dictionary: d, locale: "cs", product }),
    );
    expect(html).not.toContain('role="spinbutton"');
    expect(html).toContain("Vyberte variantu");
    expect(html).toContain(d.stock.unknown);
    expect(html).not.toContain(d.commerceUnavailable);
  });
  it("uses a sold-out mobile action without a second quantity control", () => {
    const d = getDictionary("cs");
    const html = renderToStaticMarkup(
      createElement(ProductView, { dictionary: d, locale: "cs", product, variantId: "variant" }),
    );
    expect(html.match(/role="spinbutton"/gu)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Vyprodáno<\/button>/u);
  });
  it("server renders the selected variant and parameter table with purchase disabled", () => {
    const html = renderToStaticMarkup(
      createElement(ProductView, {
        dictionary: getDictionary("en"),
        locale: "en",
        product,
        variantId: "variant",
      }),
    );
    expect(html).toContain("Owner value");
    expect(html).toContain("package");
    expect(html).toContain('role="tab"');
    expect(html).toContain("450");
    expect(html).toMatch(/<button[^>]*disabled/u);
  });
  it("does not automatically choose the only variant or an unrelated unknown ID", () => {
    expect(product.variantCount).toBe(1);
    expect(product.priceFrom).toBe(false);
    for (const id of [undefined, "other"]) {
      const selection = selectProductDetail(product, id);
      expect(selection.selectionRequired).toBe(true);
      expect(selection.variant).toBeUndefined();
    }
  });
  it("uses selected owner price, stock, quantity, unit and image order", () => {
    const selected = selectProductDetail(product, "variant");
    expect(selected.current).toMatchObject({
      minimumQuantity: 2,
      priceFrom: false,
      priceMinor: 45_000,
      sku: "V1",
      stock: "unavailable",
      unit: "package",
    });
    expect(selected.images).toEqual([
      "https://media.example/back.png",
      "https://media.example/front.png",
    ]);
    expect(selected.selectionRequired).toBe(false);
  });
});
