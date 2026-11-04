import { describe, expect, it } from "effect-rstest";
import { projectCatalog, publicImage } from "../src/ontos/catalog-model";
import type { CatalogResponseSchema } from "../src/ontos/catalog-model";

const response: typeof CatalogResponseSchema.Type = {
  market: { configured: true, currency: "CZK", marketId: "N1-CZ" },
  products: [
    {
      availability: "IN_STOCK",
      currency: "CZK",
      grossPriceMinor: 119_900,
      id: "product",
      name: "Owner product",
      slug: "product",
      stockOnHand: 3,
      stockTracked: true,
    },
  ],
};

describe("owner catalogue presentation", () => {
  it("retains the compact owner preview and the total count without needing full variant records", () => {
    const variants = [
      { id: "first", name: "8,5 - ML" },
      { id: "second", name: "6,5 - XS" },
      { id: "third", name: "7 - S" },
    ];
    const result = projectCatalog(
      {
        ...response,
        products: [
          {
            ...response.products[0],
            storefrontVariantPreview: { total: 5, variants },
            variantSummary: { count: 5, minGrossPriceMinor: 45_000, stockOnHand: 10 },
          },
        ],
      },
      [],
    );
    expect(result.products[0].variantPreview).toEqual(variants);
    expect(result.products[0].variantCount).toBe(5);
  });
  it("does not invent variant labels from a summary count", () => {
    const result = projectCatalog(
      {
        ...response,
        products: [
          {
            ...response.products[0],
            variantSummary: { count: 8, minGrossPriceMinor: 45_000, stockOnHand: 10 },
          },
        ],
      },
      [],
    );
    expect(result.products[0].variantPreview ?? []).toEqual([]);
  });
  it("uses current gallery order and respects explicit removal of every photo", () => {
    const product = { ...response.products[0], imageSrc: "https://media.example/old.png" };
    expect(
      projectCatalog(
        { ...response, products: [{ ...product, gallery: ["https://media.example/new.png"] }] },
        ["media.example"],
      ).products[0].image,
    ).toBe("https://media.example/new.png");
    expect(
      projectCatalog({ ...response, products: [{ ...product, gallery: [] }] }, ["media.example"])
        .products[0].image,
    ).toBeNull();
  });
  it("keeps missing availability unknown even when the raw stock count is positive", () => {
    const product = {
      id: "new",
      name: "Owner product",
      slug: "new",
      stockOnHand: 100,
      stockTracked: true,
    };
    expect(projectCatalog({ ...response, products: [product] }, []).products[0].stock).toBe(
      "unknown",
    );
  });
  it("uses the actual owner price and availability", () => {
    expect(projectCatalog(response, []).products[0]).toMatchObject({
      priceMinor: 119_900,
      stock: "available",
    });
  });
  it("uses the owner market currency when a product does not repeat it", () => {
    const [firstProduct] = response.products;
    const { currency, ...product } = firstProduct;
    void currency;
    expect(projectCatalog({ ...response, products: [product] }, []).products[0].priceMinor).toBe(
      119_900,
    );
    expect(
      projectCatalog(
        {
          ...response,
          products: [
            {
              ...product,
              variantSummary: { count: 2, minGrossPriceMinor: 95_900, stockOnHand: 42 },
            },
          ],
        },
        [],
      ).products[0].priceMinor,
    ).toBe(95_900);
  });
  it.each([0, -1, 1.5, Number.NaN])(
    "never fabricates a price for invalid value %s",
    (grossPriceMinor) => {
      expect(
        projectCatalog(
          { ...response, products: [{ ...response.products[0], grossPriceMinor }] },
          [],
        ).products[0].priceMinor,
      ).toBeNull();
    },
  );
  it("does not relabel a foreign currency as CZK", () => {
    expect(
      projectCatalog({ ...response, products: [{ ...response.products[0], currency: "EUR" }] }, [])
        .products[0].priceMinor,
    ).toBeNull();
  });
  it.each([{ stockTracked: false }, { availability: "UNKNOWN" }])(
    "never derives in-stock from a count alone: %j",
    (change) => {
      expect(
        projectCatalog({ ...response, products: [{ ...response.products[0], ...change }] }, [])
          .products[0].stock,
      ).toBe("unknown");
    },
  );
  it("keeps an empty owner catalogue empty", () => {
    expect(projectCatalog({ ...response, products: [] }, []).products).toEqual([]);
  });
  it("retains full detail data without inventing prices, media or inactive variants", () => {
    const {
      details: [detail],
    } = projectCatalog(
      {
        ...response,
        products: [
          {
            ...response.products[0],
            descriptionParagraphs: ["Real owner paragraph"],
            gallery: [
              "https://media.example/front.png",
              "media:unresolved",
              "https://media.example/back.png",
            ],
            parameters: [{ label: "Material", unit: "", value: "Cotton" }],
            variantRecords: [
              {
                active: true,
                attributes: "Size M",
                availability: "IN_STOCK",
                grossPriceMinor: 45_000,
                id: "active",
                name: "M",
                sku: "M-1",
                stockOnHand: 2,
              },
              {
                active: false,
                attributes: "Size S",
                availability: "IN_STOCK",
                grossPriceMinor: 40_000,
                id: "inactive",
                name: "S",
                sku: "S-1",
                stockOnHand: 2,
              },
            ],
          },
        ],
      },
      ["media.example"],
    );
    expect(detail.paragraphs).toEqual(["Real owner paragraph"]);
    expect(detail.images).toEqual([
      "https://media.example/front.png",
      "https://media.example/back.png",
    ]);
    expect(detail.parameters).toEqual([{ label: "Material", unit: "", value: "Cotton" }]);
    expect(detail.variants).toEqual([
      expect.objectContaining({ id: "active", priceMinor: 45_000, stock: "available" }),
    ]);
    expect(projectCatalog(response, []).products[0]).not.toHaveProperty("variants");
  });
  it("uses the owner variant minimum rather than the group price", () => {
    const products = [
      {
        ...response.products[0],
        variantSummary: { count: 3, minGrossPriceMinor: 45_000, stockOnHand: 5 },
      },
    ];
    expect(projectCatalog({ ...response, products }, []).products[0]).toMatchObject({
      priceFrom: true,
      priceMinor: 45_000,
    });
  });
  it("allows approved HTTPS images and rejects credentials, media references and unapproved origins", () => {
    expect(publicImage("https://media.example/p.png", ["media.example"])).toBe(
      "https://media.example/p.png",
    );
    for (const value of [
      "media:asset",
      "/akros/p.png",
      "//other.example/p.png",
      "https://other.example/p.png",
      "https://user:secret@media.example/p.png",
    ]) {
      expect(publicImage(value, ["media.example"])).toBeNull();
    }
  });
});
