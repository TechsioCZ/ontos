import { describe, it, expect } from "vitest";
import { imagePlaceholder, project } from "@/ontos/catalog-projection";
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
      minimumQuantity: 10,
      quantityStep: 10,
      packageQuantity: 10,
    });
    expect(s.revision).toBe(7);
  });
  it("excludes unpublished, inactive and identity-less products", () => {
    expect(
      project({
        products: [
          { ...live(), published: false },
          { ...live(), active: false },
          { ...live(), id: "" },
          { ...live(), slug: undefined },
        ],
      }).catalog.products,
    ).toEqual([]);
    expect(project({ products: [] }).catalog.products).toEqual([]);
  });
  it("offers a new owner product that Kai's prototype JSON does not know", () => {
    const s = project({
      products: [{ ...live(), id: "owner-new", slug: "novy-produkt", sku: "NEW-1" }],
    });
    expect(s.catalog.products.map((p) => p.slug)).toEqual(["novy-produkt"]);
  });
  it("takes every customer-visible text, image, parameter and label from the owner", () => {
    const s = project({
      revision: 3,
      total: 1289,
      page: 2,
      pageSize: 24,
      homepageFeaturedProductIds: [template.id],
      categories: [
        {
          id: "c1",
          parentId: null,
          slug: "nerez",
          name: "Nerez",
          position: 2,
          description: "Popis kategorie",
        },
        {
          id: "c2",
          parentId: "c1",
          slug: "srouby",
          name: "Šrouby",
          position: 1,
          imageSrc: "https://evil.example/x.jpg",
        },
      ],
      products: [
        {
          ...live(),
          name: "Upravený název z OntOS",
          categoryId: "c2",
          description: "První odstavec.\n\nDruhý odstavec.",
          descriptionParagraphs: ["Starý odstavec"],
          imageSrc: "https://www.akros.cz/data/product/a.jpg",
          gallery: ["https://www.akros.cz/data/product/a.jpg", "/akros/products/product-02.jpg"],
          parameters: [{ label: "Materiál", value: "A2", unit: "" }],
          flags: { isNew: true, isSale: false, isAction: true, isRecommended: false },
        },
      ],
    });
    const product = s.catalog.products[0];
    expect(product).toMatchObject({
      name: "Upravený název z OntOS",
      description: "První odstavec.",
      imageSrc: "https://www.akros.cz/data/product/a.jpg",
      secondaryImageSrc: "/akros/products/product-02.jpg",
      isNew: true,
      isAction: true,
      isSale: false,
    });
    expect(product.detail.descriptionParagraphs).toEqual(["První odstavec.", "Druhý odstavec."]);
    expect(product.detail.parameters).toEqual([{ label: "Materiál", value: "A2", unit: "" }]);
    expect(s).toMatchObject({ revision: 3, total: 1289, page: 2, pageSize: 24 });
    expect(s.catalog.homepageFeaturedProductIds).toEqual([template.id]);
    const model = createCatalog(s.catalog, s.categories);
    expect(model.getCategoryBySlug("nerez")).toMatchObject({
      hasChildren: true,
      description: "Popis kategorie",
    });
    expect(model.getCategoryBySlug("srouby")).toMatchObject({
      hasChildren: false,
      imageSrc: undefined,
    });
    expect(model.getCategoryTrail(model.getCategoryBySlug("srouby")!).map((c) => c.slug)).toEqual([
      "nerez",
      "srouby",
    ]);
  });
  it("replaces images next/image cannot serve with the honest placeholder", () => {
    const p = {
      ...live(),
      imageSrc: "http://www.akros.cz/data/x.jpg",
      gallery: ["https://cdn.example/x.jpg"],
    };
    expect(project({ products: [p] }).catalog.products[0].imageSrc).toBe(imagePlaceholder);
  });
  it("uses the first OntOS gallery image as the main image after a staff image change", () => {
    const p = {
      ...live(),
      imageSrc: "/akros/products/image-unavailable.svg",
      gallery: ["https://www.akros.cz/data/product/b.jpg"],
    };
    expect(project({ products: [p] }).catalog.products[0]).toMatchObject({
      imageSrc: "https://www.akros.cz/data/product/b.jpg",
      secondaryImageSrc: undefined,
    });
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
  it("matches the owner's gross-line VAT rounding instead of multiplying a rounded net unit", () => {
    const draft = { ...createCheckoutDraft(), deliveryId: "osobni", paymentId: "store-card" };
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
          minimumQuantity: 20,
          stockCount: 1000,
          priceMinor: 97,
          priceExcludingVatMinor: 80,
          quantity: 200,
          vatRate: 21,
        },
      ],
    };
    expect(getCheckoutTotals(cart, draft, true)).toMatchObject({
      net: 16033,
      vat: 3367,
      total: 19400,
    });
    expect(getCheckoutTotals(cart, draft, false)).toMatchObject({ net: 16000, total: 19400 });
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
