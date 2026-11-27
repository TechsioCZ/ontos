import { describe, expect, it } from "vitest";

import { cs } from "@/i18n/cs";
import {
  erpDetailStockLabel,
  erpStockSummary,
  toErpStock,
  type CatalogVariantOnHand,
  type ErpProduct,
} from "@/lib/erp-catalogue";
import { getProductStockStatus, productStockTone, stockStatusLabel } from "@/lib/product-stock";
import { projectProducts } from "@/ontos/catalog-projection";
import { firstOrderableQuantity } from "@app/merchandise/domain/order-quantity";

const erpVariantRef = {
  moduleId: "commerce.catalog",
  resourceType: "commerce.catalog.variant",
  resourceId: "20000000-0000-4000-8000-000000000001",
  tenantId: "bceaa540-13eb-5508-9ac0-9ed7e40a2ee9",
};

describe("getProductStockStatus", () => {
  it("follows the owner: stock held below one package is named and never sold", () => {
    const belowPackage = { stockOnHand: 6, firstOrderableQuantity: 10 };
    expect(getProductStockStatus({ stockCount: 10 })).toBe("in-stock");
    expect(getProductStockStatus({ stockCount: 0 })).toBe("out-of-stock");
    expect(getProductStockStatus({ stockCount: 0, belowPackage })).toBe("below-package");
    expect(getProductStockStatus({ availabilityUnknown: true, belowPackage, stockCount: 0 })).toBe(
      "unknown",
    );
    expect(stockStatusLabel(cs, "below-package", belowPackage, "ks")).toBe(
      "Skladem 6 ks, prodej po 10 ks",
    );
    expect(stockStatusLabel(cs, "below-package", { stockOnHand: 12 }, "ks")).toBe(
      "Skladem méně než balení",
    );
  });
});

/** The owner's verdict (Merchandise `availabilityOf`) as the storefront projects and words it. */
const unit = (availability: string, stockOnHand: number, packageQuantity?: number) => ({
  availability,
  stockOnHand,
  minimumQuantity: 1,
  ...(packageQuantity === undefined ? {} : { packageQuantity }),
  unit: "ks",
});
const simple = (record: Record<string, unknown>) =>
  projectProducts({
    products: [
      {
        id: "p",
        slug: "desticky",
        name: "Destičky",
        currency: "CZK",
        grossPriceMinor: 6000,
        currentPriceMinor: 4959,
        variantSummary: { count: 0, minGrossPriceMinor: null, stockOnHand: 0, units: [] },
        ...record,
      },
    ],
  }).products[0]!;
const variant = (id: string, record: ReturnType<typeof unit>) => ({
  id,
  sku: id.toUpperCase(),
  active: true,
  priceMinor: 4959,
  grossPriceMinor: 6000,
  ...record,
});
const group = (availability: string, ...variants: ReturnType<typeof variant>[]) =>
  projectProducts({
    products: [
      {
        id: "g",
        slug: "skupina",
        name: "Skupina",
        currency: "CZK",
        availability,
        unit: "ks",
        variantSummary: {
          count: variants.length,
          minGrossPriceMinor: 6000,
          stockOnHand: variants.reduce((sum, { stockOnHand }) => sum + stockOnHand, 0),
          units: ["ks"],
        },
        variantRecords: variants,
      },
    ],
  }).products[0]!;
const shown = (item: Parameters<typeof getProductStockStatus>[0] & { unit: string }) => {
  const status = getProductStockStatus(item);
  return {
    status,
    label: stockStatusLabel(cs, status, item.belowPackage, item.unit),
    tone: productStockTone(status),
  };
};

describe("one stock rule: in stock only when stock covers one first order", () => {
  it.each([
    // Packages of 10: 6 are held, not sold; 10 and 16 cover one first order.
    {
      owner: unit("OUT_OF_STOCK", 6, 10),
      stockCount: 0,
      belowPackage: { stockOnHand: 6, firstOrderableQuantity: 10 },
      status: "below-package",
      label: "Skladem 6 ks, prodej po 10 ks",
      tone: "out-of-stock",
    },
    {
      owner: unit("LOW_STOCK", 10, 10),
      stockCount: 10,
      status: "in-stock",
      label: "Skladem",
      tone: "in-stock",
    },
    {
      owner: unit("IN_STOCK", 16, 10),
      stockCount: 16,
      status: "in-stock",
      label: "Skladem",
      tone: "in-stock",
    },
    // No package: the first order is the minimum, one piece.
    {
      owner: unit("IN_STOCK", 1),
      stockCount: 1,
      status: "in-stock",
      label: "Skladem",
      tone: "in-stock",
    },
    {
      owner: unit("OUT_OF_STOCK", 0.5),
      stockCount: 0,
      belowPackage: { stockOnHand: 0.5, firstOrderableQuantity: 1 },
      status: "below-package",
      label: "Skladem 0,5 ks, prodej po 1 ks",
      tone: "out-of-stock",
    },
    {
      owner: unit("OUT_OF_STOCK", 0, 10),
      stockCount: 0,
      status: "out-of-stock",
      label: "Není skladem",
      tone: "out-of-stock",
    },
    // Stock tracking off: the owner says UNKNOWN whatever it holds, and the shop never sells it.
    {
      owner: { ...unit("UNKNOWN", 16, 10), stockTracked: false },
      stockCount: 0,
      availabilityUnknown: true,
      status: "unknown",
      label: "Dostupnost nelze ověřit",
      tone: "limited-stock",
    },
  ])(
    "$owner.availability with $owner.stockOnHand in packages of $owner.packageQuantity reads „$label“",
    ({ owner, stockCount, belowPackage, availabilityUnknown, status, label, tone }) => {
      const product = simple(owner);
      expect(product.stockCount).toBe(stockCount);
      expect(product.belowPackage).toEqual(belowPackage);
      expect(product.availabilityUnknown).toBe(availabilityUnknown);
      expect(shown(product)).toEqual({ status, label, tone });
    },
  );

  it("judges each variant of a group by its own first order; the group is in stock when one variant is", () => {
    const below = variant("a", unit("OUT_OF_STOCK", 6, 10));
    const mixed = group("IN_STOCK", below, variant("b", unit("IN_STOCK", 5)));
    expect(mixed.detail.variants.map(shown)).toEqual([
      { status: "below-package", label: "Skladem 6 ks, prodej po 10 ks", tone: "out-of-stock" },
      { status: "in-stock", label: "Skladem", tone: "in-stock" },
    ]);
    expect(mixed.belowPackage).toBeUndefined();
    expect(shown(mixed)).toEqual({ status: "in-stock", label: "Skladem", tone: "in-stock" });
    // Two variants each holding 6 in packages of 10: 12 together still sell neither.
    const allBelow = group("OUT_OF_STOCK", below, variant("c", unit("OUT_OF_STOCK", 6, 10)));
    expect(allBelow.stockCount).toBe(0);
    expect(shown(allBelow)).toEqual({
      status: "below-package",
      label: "Skladem méně než balení",
      tone: "out-of-stock",
    });
  });

  it.each([
    {
      onHand: { outcome: "ON_HAND", total: { amount: "155" } },
      label: "Skladem",
      status: "in-stock",
    },
    {
      onHand: { outcome: "ON_HAND", total: { amount: "1" } },
      label: "Skladem",
      status: "in-stock",
    },
    {
      onHand: { outcome: "ON_HAND", total: { amount: "0.5" } },
      label: "Skladem 0,5 ks, prodej po 1 ks",
      status: "below-package",
    },
    {
      onHand: { outcome: "ON_HAND", total: { amount: "0" } },
      label: "Není skladem",
      status: "out-of-stock",
    },
    {
      onHand: { outcome: "ON_HAND_UNKNOWN" },
      label: "Dostupnost nelze ověřit",
      status: "unknown",
    },
    { onHand: undefined, label: "Dostupnost nelze ověřit", status: "unknown" },
  ])(
    "an ERP variant with $onHand.outcome $onHand.total.amount reads „$label“",
    ({ onHand, label, status }) => {
      const stock = toErpStock(
        onHand && ({ ...onHand, variantRef: erpVariantRef } as CatalogVariantOnHand),
      );
      expect(shown(stock)).toMatchObject({ status, label });
    },
  );

  it("sells an ERP variant from the owner's first order of a unit without minimum or package", () => {
    const held = toErpStock({
      outcome: "ON_HAND",
      variantRef: erpVariantRef,
      total: { amount: "0.5" },
    });
    expect(held.belowPackage?.firstOrderableQuantity).toBe(firstOrderableQuantity({}));
  });

  it("words one ERP unit alike on its card, suggestion and detail page, and a group as the shop's product page", () => {
    const stock = (amount?: string) =>
      toErpStock(
        amount === undefined
          ? undefined
          : ({
              outcome: "ON_HAND",
              total: { amount },
              variantRef: erpVariantRef,
            } as CatalogVariantOnHand),
      );
    const product = (...amounts: (string | undefined)[]) =>
      ({ variants: amounts.map((amount) => ({ stock: stock(amount) })) }) as unknown as ErpProduct;
    const card = (item: ErpProduct) => erpStockSummary(item, cs);
    expect(card(product("155"))).toEqual({ stockLabel: "Skladem", stockTone: "in-stock" });
    expect(card(product("0.5"))).toEqual({
      stockLabel: "Skladem 0,5 ks, prodej po 1 ks",
      stockTone: "out-of-stock",
    });
    expect(card(product("0"))).toEqual({ stockLabel: "Není skladem", stockTone: "out-of-stock" });
    expect(card(product(undefined))).toEqual({
      stockLabel: "Dostupnost nelze ověřit",
      stockTone: "limited-stock",
    });
    expect(card(product("0", "155"))).toEqual({ stockLabel: "Skladem", stockTone: "in-stock" });
    expect(card(product("0.5", "0.5"))).toEqual({
      stockLabel: "Skladem méně než balení",
      stockTone: "out-of-stock",
    });
    for (const amount of ["155", "0.5", "0", undefined])
      expect(erpDetailStockLabel(product(amount), cs)).toBe(card(product(amount)).stockLabel);
    expect(erpDetailStockLabel(product("155"), cs)).toBe("Skladem");
    expect(erpDetailStockLabel(product(undefined), cs)).toBe("Dostupnost nelze ověřit");
    expect(erpDetailStockLabel(product("0", "155"), cs)).toBe("Skladem 1 z 2 variant");
    expect(erpDetailStockLabel(product("0.5", "0"), cs)).toBe("Skladem méně než balení");
    expect(erpDetailStockLabel(product("0", "0"), cs)).toBe(
      "Momentálně není skladem žádná varianta",
    );
  });
});
