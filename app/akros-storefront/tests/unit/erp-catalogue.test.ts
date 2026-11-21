import { describe, expect, it } from "vitest";

import {
  shownVariantRefs,
  erpCardSummary,
  erpPriceLabel,
  erpStockLabel,
  toErpProducts,
  type CatalogPagePrices,
  type CatalogProductPage,
  type CatalogVariantOnHand,
} from "@/lib/erp-catalogue";
import { parseErpOffers } from "@/ontos/erp-config";
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
  lifecycle: "WORK_IN_PROGRESS",
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
      lifecycle: "DRAFT",
      localized: {
        kind: "PRESENT",
        locale: "cs",
        name: "Šroub z ERP",
        description: "První odstavec.\n\nDruhý odstavec.",
      },
      categories: [{ name: "Spojovací materiál" }],
      media: [{ assignment: {}, ownerAvailability: "UNVERIFIED" }],
      variants: [1, 2, 3, 4, 5, 6]
        .map((n) => variant(n, n === 6 ? { lifecycle: "ACTIVE" } : {}))
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
  it("asks stock and price for exactly the variants that are not RETIRED (WORK_IN_PROGRESS and ACTIVE)", () => {
    expect(shownVariantRefs(page).map(({ resourceId }) => resourceId)).toEqual(
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

  it("titles an untranslated DRAFT product by its first variant's name, else „not translated“, and drops one with only RETIRED variants", () => {
    const missing = { kind: "MISSING_TRANSLATION" as const, requestedLocale: "cs" };
    const untranslated: CatalogProductPage = {
      count: 3,
      items: [
        {
          ...page.items[0]!,
          localized: missing,
          variants: [
            variant(7, {
              lifecycle: "RETIRED",
              localized: { kind: "PRESENT", locale: "cs", name: "Vyřazená" },
            }),
            variant(1, { localized: { kind: "PRESENT", locale: "cs", name: "Šroub M1" } }),
          ],
        },
        { ...page.items[0]!, localized: missing, variants: [variant(2, { sku: undefined })] },
        { ...page.items[0]!, variants: [variant(7, { lifecycle: "RETIRED" })] },
      ],
    };
    const products = toErpProducts(untranslated, onHand.slice(0, 1), prices);
    expect(
      products.map(({ name, descriptionParagraphs }) => ({ name, descriptionParagraphs })),
    ).toEqual([
      { name: "Šroub M1", descriptionParagraphs: [] },
      { name: "Název zatím není přeložen", descriptionParagraphs: [] },
    ]);
    expect(products[1]!.variants[0]).not.toHaveProperty("sku");
    expect(erpCardSummary(products[0]!, "cs")).toEqual({
      priceLabel: "1\u00a0234,50\u00a0Kč bez DPH",
      stockLabel: "Skladem: 42 ks",
      stockTone: "in-stock",
    });
  });
});

describe("ERP offers by company", () => {
  const akros = "c0c78a3e-6e2a-57e0-9d0d-86253499fee7";
  const shop = "71000000-0000-4000-8000-000000000024";
  const offer = {
    customerConfigurationId: "akros-eshop",
    channelId: "B2C",
    marketId: "akros-cz",
    currencyCode: "CZK",
    unitId: "43d5c797-2b36-4877-85ad-caac3a674d9c",
    unitQuantity: "1",
  };

  it("takes the entry of this storefront's own company, and none is off", () => {
    const raw = JSON.stringify({ [akros]: offer });
    expect(parseErpOffers(raw, akros)).toEqual(offer);
    expect(parseErpOffers(raw, shop)).toBeUndefined();
    expect(parseErpOffers(undefined, akros)).toBeUndefined();
    expect(parseErpOffers(" ", akros)).toBeUndefined();
  });

  it("refuses a value that is not an object keyed by Legal Entity id, or any malformed entry", () => {
    expect(() => parseErpOffers(JSON.stringify(offer), akros)).toThrow(/not a Legal Entity id/u);
    expect(() => parseErpOffers(JSON.stringify([offer]), akros)).toThrow(/not a JSON object/u);
    expect(() =>
      parseErpOffers(
        JSON.stringify({ [akros]: offer, [shop]: { ...offer, channelId: "__CHANNEL__" } }),
        akros,
      ),
    ).toThrow(/needs customerConfigurationId/u);
  });
});
