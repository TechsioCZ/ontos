import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "@rstest/core";
import { getDictionary } from "../src/i18n";
import { projectCatalog } from "../src/ontos/catalog-model";
import type { CatalogResponseSchema } from "../src/ontos/catalog-model";
import { ListingCards } from "../src/features/listing-cards";
import { CatalogView } from "../src/features/catalog-view";

type OwnerProduct = (typeof CatalogResponseSchema.Type.products)[number];
const simpleOwner = {
  availability: "IN_STOCK",
  currency: "CZK",
  currentPriceMinor: 99_091,
  grossPriceMinor: 119_900,
  id: "simple",
  minimumQuantity: 1,
  name: "Owner product",
  packageQuantity: 1,
  slug: "simple",
  stockOnHand: 7,
  stockTracked: true,
  storefrontVariantPreview: { total: 0, variants: [] },
  unit: "ks",
  variantSummary: { count: 0, minGrossPriceMinor: null, stockOnHand: 0 },
} satisfies OwnerProduct;

const catalogue = (
  changes: Partial<OwnerProduct> = {},
  currency: (typeof CatalogResponseSchema.Type.market)["currency"] = "CZK",
) =>
  projectCatalog(
    {
      market: { configured: true, currency, marketId: "owner-market" },
      products: [{ ...simpleOwner, ...changes }],
    },
    [],
  );

describe("mobile listing net caption provenance", () => {
  it("preserves the owner's explicit simple-product gross/net pair", () => {
    expect(catalogue().products[0]).toMatchObject({
      priceExcludingVatMinor: 99_091,
      priceMinor: 119_900,
    });
    expect(catalogue({ availability: "LOW_STOCK" }).products[0]).toHaveProperty(
      "priceExcludingVatMinor",
      99_091,
    );
  });
  it("uses only the exact displayed-gross tier instead of unrelated parent or tier prices", () => {
    const result = catalogue({
      currentPriceMinor: 90_000,
      priceTiers: [
        { minimumQuantity: 1, priceExcludingVatMinor: 100_001, priceMinor: 119_900 },
        { minimumQuantity: 10, priceExcludingVatMinor: 70_000, priceMinor: 90_000 },
      ],
    });
    expect(result.products[0]).toHaveProperty("priceExcludingVatMinor", 100_001);
  });
  it("accepts duplicate matching tiers only when they agree on the same net amount", () => {
    expect(
      catalogue({
        priceTiers: [
          { minimumQuantity: 1, priceExcludingVatMinor: 99_091, priceMinor: 119_900 },
          { minimumQuantity: 3, priceExcludingVatMinor: 99_091, priceMinor: 119_900 },
        ],
      }).products[0],
    ).toHaveProperty("priceExcludingVatMinor", 99_091);
  });
  it.each([
    [
      "non-null group-minimum evidence even when equal to parent gross",
      { variantSummary: { count: 0, minGrossPriceMinor: 119_900, stockOnHand: 0 } },
    ],
    [
      "a one-variant group with numerically matching parent gross/net",
      {
        storefrontVariantPreview: { total: 1, variants: [{ id: "v", name: "M" }] },
        variantSummary: { count: 1, minGrossPriceMinor: 119_900, stockOnHand: 7 },
      },
    ],
    [
      "a multi-variant group with matching parent gross/net",
      {
        storefrontVariantPreview: { total: 2, variants: [] },
        variantSummary: { count: 2, minGrossPriceMinor: 119_900, stockOnHand: 7 },
      },
    ],
    [
      "contradictory count evidence",
      { variantSummary: { count: 1, minGrossPriceMinor: null, stockOnHand: 7 } },
    ],
    [
      "variant labels contradicting a zero total",
      { storefrontVariantPreview: { total: 0, variants: [{ id: "v", name: "M" }] } },
    ],
    [
      "native all-inactive parent: zero active variants but OUT_OF_STOCK",
      { availability: "OUT_OF_STOCK" },
    ],
    ["unknown availability", { availability: "UNKNOWN" }],
    ["untracked stock", { stockTracked: false }],
    ["zero stock", { stockOnHand: 0 }],
    ["a foreign product currency", { currency: "EUR" }],
    ["a missing displayed gross amount", { grossPriceMinor: 0 }],
    [
      "a tier that does not match displayed gross",
      {
        priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: 100_000, priceMinor: 121_000 }],
      },
    ],
    [
      "matching tier without native net",
      { priceTiers: [{ minimumQuantity: 1, priceMinor: 119_900 }] },
    ],
    [
      "ambiguous matching tier net amounts",
      {
        priceTiers: [
          { minimumQuantity: 1, priceExcludingVatMinor: 99_091, priceMinor: 119_900 },
          { minimumQuantity: 3, priceExcludingVatMinor: 100_000, priceMinor: 119_900 },
        ],
      },
    ],
  ] satisfies [string, Partial<OwnerProduct>][])(
    "omits a net caption for %s",
    (_description, changes) => {
      expect(catalogue(changes).products[0]).not.toHaveProperty("priceExcludingVatMinor");
    },
  );
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 119_901])(
    "never fabricates a net amount from invalid owner value %s",
    (currentPriceMinor) => {
      expect(catalogue({ currentPriceMinor }).products[0]).not.toHaveProperty(
        "priceExcludingVatMinor",
      );
    },
  );
  it("keeps missing counts and a missing native net amount unknown", () => {
    const { storefrontVariantPreview, variantSummary, ...legacy } = simpleOwner;
    void storefrontVariantPreview;
    void variantSummary;
    const result = projectCatalog(
      { market: { configured: true, currency: "CZK", marketId: "market" }, products: [legacy] },
      [],
    );
    expect(result.products[0]).not.toHaveProperty("priceExcludingVatMinor");
    const { currentPriceMinor: omittedNet, ...withoutNet } = simpleOwner;
    void omittedNet;
    expect(
      projectCatalog(
        {
          market: { configured: true, currency: "CZK", marketId: "market" },
          products: [withoutNet],
        },
        [],
      ).products[0],
    ).not.toHaveProperty("priceExcludingVatMinor");
  });
  it("preserves the native market-currency pair without doing currency or VAT calculations", () => {
    expect(
      catalogue({ currency: "EUR", currentPriceMinor: 1000, grossPriceMinor: 1299 }, "EUR")
        .products[0],
    ).toMatchObject({ currency: "EUR", priceExcludingVatMinor: 1000, priceMinor: 1299 });
  });
  it("renders the existing PriceBlock caption only in mobile ListingCards, not featured cards", () => {
    const catalog = catalogue();
    const dictionary = getDictionary("cs");
    const listing = renderToStaticMarkup(
      <ListingCards catalog={catalog} dictionary={dictionary} locale="cs" />,
    );
    const featured = renderToStaticMarkup(
      <CatalogView
        catalog={catalog}
        dictionary={dictionary}
        locale="cs"
        title={dictionary.featured}
      />,
    );
    expect(listing).toContain("990,91");
    expect(listing).toContain("bez DPH");
    expect(featured).not.toContain("bez DPH");
    expect(listing).toContain('href="/cs/produkt/simple"');
  });
  it("does not alter existing full PDP net-price behavior for sold-out products", () => {
    const result = catalogue({ availability: "OUT_OF_STOCK" });
    expect(result.products[0]).not.toHaveProperty("priceExcludingVatMinor");
    expect(result.details[0]).toHaveProperty("priceExcludingVatMinor", 99_091);
  });
});
