import { describe, it, expect } from "vitest";
import { project } from "@/ontos/catalog-projection";
import raw from "@/mock-storefront/generated/catalog.generated.json";
import { createCatalog } from "@/ontos/catalog-model";
import { createCheckoutDraft, getCheckoutTotals } from "@/mock-storefront/checkout";
const template = raw.products.find((p) => p.detail.variants.length > 1)!;
const variant = template.detail.variants[0];
const live = () => ({
  id: template.id,
  name: template.name,
  slug: template.slug,
  active: true,
  published: true,
  variantRecords: [
    {
      id: variant.id,
      sku: variant.sku,
      active: true,
      priceMinor: 100,
      grossPriceMinor: 121,
      stockOnHand: 40,
      minimumQuantity: 2,
      packageQuantity: 10,
      priceTiers: [{ minimumQuantity: 20, priceMinor: 110, priceExcludingVatMinor: 91 }],
    },
  ],
});
describe("OntOS source-of-truth boundary", () => {
  it("offers only owner products and variants, never the rest of the prototype", () => {
    const s = project({ revision: 7, products: [live()] });
    const model = createCatalog(s.catalog, s.categories);
    expect(model.getProducts()).toHaveLength(1);
    expect(model.getProducts()[0].detail.variants).toHaveLength(1);
    expect(model.getProducts()[0].detail.variants[0]).toMatchObject({
      priceMinor: 121,
      stockCount: 40,
      minimumQuantity: 2,
      packageQuantity: 10,
    });
    expect(s.revision).toBe(7);
  });
  it("excludes unpublished, inactive, absent, and unknown products", () => {
    expect(
      project({
        products: [
          { ...live(), published: false },
          { ...live(), active: false },
          { ...live(), id: "not-seeded", slug: "unknown", sku: "missing" },
        ],
      }).catalog.products,
    ).toEqual([]);
    expect(project({ products: [] }).catalog.products).toEqual([]);
  });
  it("never backfills an absent owner price or stock from JSON", () => {
    for (const field of ["grossPriceMinor", "priceMinor", "stockOnHand", "minimumQuantity"]) {
      const p = live();
      delete (p.variantRecords[0] as Record<string, unknown>)[field];
      expect(project({ products: [p] }).catalog.products).toEqual([]);
    }
  });
  it("keeps tier net/gross values and filters inactive variants", () => {
    const p = live();
    expect(
      project({ products: [p] }).catalog.products[0].detail.variants[0].priceTiers,
    ).toContainEqual({ minimumQuantity: 20, priceMinor: 110, priceExcludingVatMinor: 91 });
    p.variantRecords[0].active = false;
    expect(project({ products: [p] }).catalog.products).toEqual([]);
  });
  it("never mutates Kai's prototype snapshot", () => {
    const before = JSON.stringify(template);
    project({ products: [live()] });
    expect(JSON.stringify(template)).toBe(before);
  });
  it("does not apply prototype-only free shipping or extended return to a live order", () => {
    const draft = {
      ...createCheckoutDraft(),
      deliveryId: "zasilkovna",
      paymentId: "gopay",
      extendedReturn: true,
    };
    const cart = {
      version: 3 as const,
      lines: [
        {
          productId: "p",
          slug: "p",
          name: "Materiál",
          sku: "P",
          imageSrc: "",
          imageAlt: "",
          unit: "ks",
          minimumQuantity: 1,
          stockCount: 5,
          priceMinor: 250000,
          priceExcludingVatMinor: 206612,
          quantity: 1,
        },
      ],
    };
    expect(getCheckoutTotals(cart, draft).shipping).toBe(0);
    expect(getCheckoutTotals(cart, draft, true)).toMatchObject({
      shipping: 7900,
      extendedReturn: 0,
      total: 257900,
    });
  });
});
