import { describe, expect, it } from "vitest";

import {
  activeVariantRefs,
  erpCardSummary,
  erpPriceLabel,
  erpStockLabel,
  toErpProducts,
  type CatalogPagePrices,
  type CatalogProductPage,
  type CatalogVariantOnHand,
} from "@/lib/erp-catalogue";
import { imagePlaceholder } from "@/ontos/media-path";

const tenantId = "bceaa540-13eb-5508-9ac0-9ed7e40a2ee9";
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: "commerce.catalog",
  resourceType,
  resourceId,
  tenantId,
});
const productRef = ref("commerce.catalog.product", "10000000-0000-4000-8000-000000000001");
const variantRef = (n: number) =>
  ref("commerce.catalog.variant", `20000000-0000-4000-8000-00000000000${n}`);
const variant = (n: number, extra: Record<string, unknown> = {}) => ({
  variantRef: variantRef(n),
  lifecycle: "ACTIVE",
  sku: `ERP-${n}`,
  localized: { kind: "MISSING_TRANSLATION" as const, requestedLocale: "cs" },
  options: [
    {
      values: [
        { kind: "TEXT" as const, text: `M${n}` },
        { kind: "MEASUREMENT" as const, amount: n * 10, unit: "mm" },
      ],
    },
  ],
  ...extra,
});
const page: CatalogProductPage = {
  count: 1,
  items: [
    {
      productRef,
      lifecycle: "ACTIVE",
      localized: {
        kind: "PRESENT",
        locale: "cs",
        name: "Šroub z ERP",
        description: "První odstavec.\n\nDruhý odstavec.",
      },
      categories: [{ name: "Spojovací materiál" }],
      media: [{ assignment: {}, ownerAvailability: "UNVERIFIED" }],
      variants: [1, 2, 3, 4, 5, 6]
        .map((n) => variant(n))
        .concat([variant(7, { lifecycle: "RETIRED" })]),
    },
  ],
};
const onHand: CatalogVariantOnHand[] = [
  { outcome: "ON_HAND", variantRef: variantRef(1), total: { amount: "42" } },
  { outcome: "ON_HAND", variantRef: variantRef(2), total: { amount: "0" } },
  { outcome: "ON_HAND_UNKNOWN", variantRef: variantRef(3) },
  { outcome: "NO_POSITION", variantRef: variantRef(4) },
  { outcome: "CONFLICTING_BINDINGS", variantRef: variantRef(5) },
  { outcome: "NO_STOCK_ITEM", variantRef: variantRef(6) },
];
const found = (n: number, amount: string) => ({
  _tag: "PRICE_FOUND",
  catalogSelection: { productRef, variantRef: variantRef(n) },
  priceRevision: { monetaryAmount: { amount, currencyCode: "CZK" } },
});
const prices: CatalogPagePrices = {
  _tag: "CATALOG_PAGE_PRICED",
  prices: [
    found(1, "1234.5"),
    found(2, "99"),
    { _tag: "NO_APPLICABLE_PRICE", catalogSelection: { variantRef: variantRef(3) } },
    { _tag: "PRICING_CONFLICT", catalogSelection: { variantRef: variantRef(4) } },
    { _tag: "PRICING_INDETERMINATE", catalogSelection: { variantRef: variantRef(5) } },
  ],
};

describe("ERP product page model", () => {
  it("asks stock and price for exactly the ACTIVE variants", () => {
    expect(activeVariantRefs(page).map(({ resourceId }) => resourceId)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => variantRef(n).resourceId),
    );
  });

  it("maps every stock outcome and every price outcome, and never invents an image", () => {
    const [product] = toErpProducts(page, onHand, prices);
    expect(product).toMatchObject({
      id: productRef.resourceId,
      name: "Šroub z ERP",
      descriptionParagraphs: ["První odstavec.", "Druhý odstavec."],
      categories: ["Spojovací materiál"],
      imageSrc: imagePlaceholder,
    });
    const rows = product!.variants.map((item) => [
      item.sku,
      item.options.join(", "),
      erpPriceLabel(item.price, "cs"),
      erpStockLabel(item.stock, "cs"),
    ]);
    expect(rows).toEqual([
      ["ERP-1", "M1, 10 mm", "1\u00a0234,50\u00a0Kč bez DPH", "Skladem: 42 ks"],
      ["ERP-2", "M2, 20 mm", "99,00\u00a0Kč bez DPH", "Není skladem"],
      ["ERP-3", "M3, 30 mm", "Cena na dotaz", "Dostupnost ověřujeme"],
      ["ERP-4", "M4, 40 mm", "Cena na dotaz", "Dostupnost ověřujeme"],
      ["ERP-5", "M5, 50 mm", "Cena na dotaz", "Dostupnost ověřujeme"],
      ["ERP-6", "M6, 60 mm", "Cena na dotaz", "Dostupnost ověřujeme"],
    ]);
    expect(erpCardSummary(product!, "cs")).toEqual({
      priceLabel: "od 99,00\u00a0Kč bez DPH",
      stockLabel: "Skladem",
      stockTone: "in-stock",
    });
  });

  it("prices nothing when Currency Support is not current, and shows unknown stock without a figure", () => {
    const [product] = toErpProducts(page, [], { _tag: "CURRENCY_SUPPORT_NOT_CURRENT" });
    expect(product!.variants.every(({ price }) => price.kind === "on-request")).toBe(true);
    expect(product!.variants.every(({ stock }) => stock.kind === "unknown")).toBe(true);
    expect(erpCardSummary(product!, "cs")).toEqual({
      priceLabel: "Cena na dotaz",
      stockLabel: "Dostupnost ověřujeme",
      stockTone: "limited-stock",
    });
  });

  it("names an untranslated product by its first SKU and drops a product without an ACTIVE variant", () => {
    const untranslated: CatalogProductPage = {
      count: 2,
      items: [
        {
          ...page.items[0]!,
          localized: { kind: "MISSING_TRANSLATION", requestedLocale: "cs" },
          variants: [variant(1)],
        },
        { ...page.items[0]!, variants: [variant(7, { lifecycle: "RETIRED" })] },
      ],
    };
    const products = toErpProducts(untranslated, onHand.slice(0, 1), prices);
    expect(
      products.map(({ name, descriptionParagraphs }) => ({ name, descriptionParagraphs })),
    ).toEqual([{ name: "ERP-1", descriptionParagraphs: [] }]);
    expect(erpCardSummary(products[0]!, "cs")).toEqual({
      priceLabel: "1\u00a0234,50\u00a0Kč bez DPH",
      stockLabel: "Skladem: 42 ks",
      stockTone: "in-stock",
    });
  });
});
