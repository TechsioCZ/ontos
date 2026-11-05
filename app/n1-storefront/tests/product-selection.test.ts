import { describe, expect, it } from "effect-rstest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getDictionary } from "../src/i18n";
import { projectCatalog } from "../src/ontos/catalog-model";
import { selectProductDetail } from "../src/features/product-selection";
import { ProductView } from "../src/features/product-view";
import { priceProps } from "../src/features/price-props";

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
  it("switches to a non-minimum leaf price and restores the group amount when selection is cleared", () => {
    const grouped = {
      ...product,
      priceFrom: true,
      variantCount: 2,
      variants: [
        ...product.variants,
        {
          ...product.variants[0],
          id: "higher-price",
          name: "L",
          priceExcludingVatMinor: 74_380,
          priceMinor: 90_000,
        },
      ],
    };
    const selected = selectProductDetail(grouped, "higher-price");
    expect(selected.selectionRequired).toBe(false);
    expect(
      priceProps(
        selected.current,
        getDictionary("cs"),
        "cs",
        selected.current.priceExcludingVatMinor,
      ),
    ).toEqual({
      amountLabel: "900\u00A0Kč",
      state: "known",
      taxLabel: "743,8\u00A0Kč bez DPH",
    });
    for (const variantId of [undefined, "removed-variant"]) {
      const cleared = selectProductDetail(grouped, variantId);
      expect(cleared.selectionRequired).toBe(true);
      expect(cleared.current).toMatchObject({ priceExcludingVatMinor: null, priceMinor: 45_000 });
    }
  });
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

  it("lists each size exactly once on the product page", () => {
    const sizes = ["S", "M", "L", "XL", "XXL", "XXXL"];
    const {
      details: [hoodie],
    } = projectCatalog(
      {
        market: { configured: true, currency: "CZK", marketId: "owner-market" },
        products: [
          {
            availability: "IN_STOCK",
            currency: "CZK",
            gallery: ["https://media.example/front.png"],
            grossPriceMinor: 90_000,
            id: "hoodie",
            minimumQuantity: 1,
            name: "Owner hoodie",
            slug: "hoodie",
            stockTracked: true,
            unit: "piece",
            variantRecords: sizes.map((size) => ({
              active: true,
              attributes: size,
              availability: "IN_STOCK",
              grossPriceMinor: 90_000,
              id: `size-${size}`,
              imageSrc: "https://media.example/front.png",
              minimumQuantity: 1,
              name: size,
              sku: `H-${size}`,
              stockOnHand: 3,
              unit: "piece",
            })),
            variantSummary: { count: sizes.length, minGrossPriceMinor: 90_000, stockOnHand: 3 },
          },
        ],
      },
      ["media.example"],
    );
    const html = renderToStaticMarkup(
      createElement(ProductView, {
        dictionary: getDictionary("cs"),
        locale: "cs",
        product: hoodie,
        variantId: "size-M",
      }),
    );
    for (const size of sizes) {
      expect(html.split(`variantId=size-${size}"`)).toHaveLength(2);
    }
  });
});
