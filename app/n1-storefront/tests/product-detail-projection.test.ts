import { Schema } from "effect";
import { describe, expect, it } from "effect-rstest";
import { CatalogResponseSchema, projectCatalog } from "../src/ontos/catalog-model";
import { selectProductDetail } from "../src/features/product-selection";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ProductView } from "../src/features/product-view";
import { getDictionary } from "../src/i18n";

const base = {
  currency: "CZK",
  currentPriceMinor: 10_000,
  grossPriceMinor: 12_100,
  id: "owner-product",
  name: "Owner product",
  slug: "owner-product",
};
const leaf = { ...base, availability: "IN_STOCK", stockOnHand: 3, stockTracked: true };
type OwnerProductInput = (typeof CatalogResponseSchema.Encoded.products)[number] & {
  readonly vatRate?: number;
};
const detail = (product: OwnerProductInput, currency = "CZK") =>
  projectCatalog(
    Schema.decodeUnknownSync(CatalogResponseSchema)({
      market: { configured: true, currency, marketId: "owner-market" },
      products: [product],
    }),
    [],
  ).details[0];

const variant = {
  active: true,
  attributes: "",
  availability: "IN_STOCK",
  grossPriceMinor: 10_890,
  id: "owner-variant",
  name: "M",
  priceMinor: 10_000,
  priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: 9000, priceMinor: 10_890 }],
  sku: "OWNER-M",
  stockOnHand: 2,
  unit: "ks",
};

describe("owner-backed PDP amounts and stock", () => {
  it.each(["cs", "en"])(
    "renders only the proved manufacturer in %s without an invented manufacturer link",
    (locale) => {
      const dictionary = getDictionary(locale);
      const product = detail({
        ...leaf,
        parameters: [{ label: "Značka", unit: "", value: "Fox & Racing" }],
        sourceProductId: "n1legacy:sql:f7972caf6a5bac9f3050968baf274669fbdc9cbf:product:1965",
      });
      const html = renderToStaticMarkup(
        createElement(ProductView, { dictionary, locale, product }),
      );
      expect(html).toContain(`${dictionary.manufacturer}: Fox &amp; Racing`);
      expect(html).toContain(`<dt>${dictionary.manufacturer}</dt><dd>Fox &amp; Racing</dd>`);
      const missing = renderToStaticMarkup(
        createElement(ProductView, { dictionary, locale, product: detail(leaf) }),
      );
      expect(missing).not.toContain(dictionary.manufacturer);
      expect(html).not.toContain("/vyrobce/");
    },
  );
  it.each(["cs", "en"])("marks only the actual selected variant in %s", (locale) => {
    const product = detail({
      ...leaf,
      variantRecords: [variant, { ...variant, id: "second", name: "L" }],
      variantSummary: { count: 2, minGrossPriceMinor: 10_890, stockOnHand: 4 },
    });
    const dictionary = getDictionary(locale);
    const selected = renderToStaticMarkup(
      createElement(ProductView, { dictionary, locale, product, variantId: variant.id }),
    );
    const unselected = renderToStaticMarkup(
      createElement(ProductView, { dictionary, locale, product }),
    );
    expect(selected).toContain(`>M<span class="md:hidden"> · ${dictionary.selectedOption}</span>`);
    expect(selected).not.toContain(
      `L<span class="md:hidden"> · ${dictionary.selectedOption}</span>`,
    );
    expect(unselected).not.toContain(` · ${dictionary.selectedOption}`);
  });
  it.each([
    { ...leaf, variantRecords: [variant] },
    {
      ...leaf,
      variantRecords: [variant],
      variantSummary: { count: 0, minGrossPriceMinor: 10_890, stockOnHand: 42 },
    },
  ])("does not use parent amounts when active variants lack a consistent summary", (owner) => {
    const product = detail(owner);
    expect(product).toMatchObject({ priceExcludingVatMinor: null, stockQuantity: null });
    expect(selectProductDetail(product, variant.id).current).toMatchObject({
      priceExcludingVatMinor: 9000,
      stockQuantity: 2,
    });
  });
  it("renders the selected stock and paired net without exposing the group stock as its quantity", () => {
    const product = detail({
      ...leaf,
      unit: "ks",
      variantRecords: [variant],
      variantSummary: { count: 1, minGrossPriceMinor: 10_890, stockOnHand: 42 },
    });
    const html = renderToStaticMarkup(
      createElement(ProductView, {
        categories: [],
        dictionary: getDictionary("cs"),
        locale: "cs",
        product,
        variantId: variant.id,
      }),
    );
    expect(html).toContain("Skladem 2 ks");
    expect(html).not.toContain("Skladem 42 ks");
    expect(html).toContain("90\u00A0Kč bez DPH");
  });
  it("renders the exact owner category hierarchy with locale-prefixed links before the product", () => {
    const catalog = projectCatalog(
      Schema.decodeUnknownSync(CatalogResponseSchema)({
        categories: [
          { id: "unrelated", name: "Clothing", parentId: null, slug: "other-clothing" },
          { id: "root", name: "Women", parentId: null, slug: "women" },
          { id: "leaf", name: "Clothing", parentId: "root", slug: "women-clothing" },
        ],
        market: { configured: true, currency: "CZK", marketId: "owner-market" },
        products: [{ ...leaf, categoryId: "leaf" }],
      }),
      [],
    );
    const html = renderToStaticMarkup(
      createElement(ProductView, {
        categories: catalog.categories,
        dictionary: getDictionary("en"),
        locale: "en",
        product: catalog.details[0],
      }),
    );
    expect(html).toContain('href="/en/kategorie/women"');
    expect(html).toContain('href="/en/kategorie/women-clothing"');
    expect(html).not.toContain('href="/en/kategorie/other-clothing"');
    expect(html.indexOf("Women")).toBeLessThan(html.indexOf("Clothing"));
    expect(html.indexOf("Clothing")).toBeLessThan(html.indexOf("Owner product"));
  });
  it("does not render a guessed category breadcrumb for missing owner membership", () => {
    const html = renderToStaticMarkup(
      createElement(ProductView, {
        categories: [{ id: "other", name: "Owner product", parentId: null, slug: "other" }],
        dictionary: getDictionary("cs"),
        locale: "cs",
        product: detail(leaf),
      }),
    );
    expect(html).not.toContain('href="/cs/kategorie/other"');
    expect(html).toContain('aria-current="page"');
  });
  it("retains the exact standalone stock and matching base net amount through decoding", () => {
    expect(detail(leaf)).toMatchObject({ priceExcludingVatMinor: 10_000, stockQuantity: 3 });
    expect(detail({ ...leaf, stockOnHand: 0.5 }).stockQuantity).toBe(0.5);
  });

  it.each([
    { ...leaf, stockTracked: false },
    { ...leaf, availability: "UNKNOWN" },
    { ...base, stockOnHand: 3, stockTracked: true },
    { ...base, availability: "IN_STOCK", stockTracked: true },
    { ...leaf, stockOnHand: -1 },
    { ...leaf, stockOnHand: Number.POSITIVE_INFINITY },
  ])("does not invent a known stock quantity for unsupported owner stock: %j", (product) => {
    expect(detail(product).stockQuantity).toBeNull();
  });

  it("pairs the displayed gross with its explicit tier net instead of the different base net", () => {
    expect(
      detail({
        ...leaf,
        grossPriceMinor: 10_890,
        priceTiers: variant.priceTiers,
      }).priceExcludingVatMinor,
    ).toBe(9000);
  });

  it.each([
    { priceTiers: [{ minimumQuantity: 1, priceMinor: 12_100 }] },
    { priceTiers: [{ minimumQuantity: 1, priceExcludingVatMinor: 9000, priceMinor: 99_900 }] },
    {
      priceTiers: [
        { minimumQuantity: 1, priceExcludingVatMinor: 10_000, priceMinor: 12_100 },
        { minimumQuantity: 2, priceExcludingVatMinor: 9999, priceMinor: 12_100 },
      ],
    },
  ])("omits net when tier prices cannot provide one unambiguous pair: %j", ({ priceTiers }) => {
    expect(detail({ ...leaf, priceTiers }).priceExcludingVatMinor).toBeNull();
  });

  it.each([0, -1, 12_101, 10_000.5, Number.POSITIVE_INFINITY])(
    "rejects invalid base net %s without changing the owner gross price",
    (currentPriceMinor) => {
      const result = detail({ ...leaf, currentPriceMinor });
      expect(result.priceExcludingVatMinor).toBeNull();
      expect(result.priceMinor).toBe(12_100);
    },
  );

  it("does not manufacture a net amount from a VAT rate or a foreign currency", () => {
    expect(
      detail({ grossPriceMinor: 12_100, id: "p", name: "P", slug: "p", vatRate: 21 })
        .priceExcludingVatMinor,
    ).toBeNull();
    expect(detail({ ...leaf, currency: "EUR" }).priceExcludingVatMinor).toBeNull();
    expect(detail({ ...leaf, currency: "EUR" }, "EUR").priceExcludingVatMinor).toBe(10_000);
  });

  it("uses only the selected variant stock and net pair, never the group aggregate", () => {
    const product = detail({
      ...leaf,
      variantRecords: [
        variant,
        { ...variant, id: "other", name: "L", priceMinor: 9000, stockOnHand: 40 },
      ],
      variantSummary: { count: 2, minGrossPriceMinor: 10_890, stockOnHand: 42 },
    });
    expect(product).toMatchObject({ priceExcludingVatMinor: null, stockQuantity: null });
    expect(selectProductDetail(product, variant.id).current).toMatchObject({
      priceExcludingVatMinor: 9000,
      stockQuantity: 2,
    });
    expect(selectProductDetail(product, "other").current.stockQuantity).toBe(40);
    expect(selectProductDetail(product, "missing").current.stockQuantity).toBeNull();
  });
});
