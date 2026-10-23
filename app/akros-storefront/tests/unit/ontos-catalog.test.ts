import { describe, it, expect } from "vitest";
import {
  imagePlaceholder,
  projectCategories,
  projectProducts,
  purchaseProductOf,
  purchaseVariantOf,
} from "@/ontos/catalog-projection";
import raw from "@/catalog-import/generated/catalog.generated.json";
import { createCatalog } from "@/ontos/catalog-model";
import { createCheckoutDraft, getCheckoutTotals } from "@/features/checkout/checkout-state";
/** One owner response projected the way catalog-server merges products and navigation. */
const project = (body: Record<string, unknown>) => {
  const page = projectProducts(body);
  return {
    ...page,
    catalog: {
      products: page.products,
      homepageFeaturedProductIds: page.homepageFeaturedProductIds,
    },
    categories: { categories: projectCategories(body) },
  };
};
const template = raw.products.find((p) => p.detail.variants.length > 1)!;
const variant = template.detail.variants[0];
const live = () => ({
  id: template.id,
  name: template.name,
  slug: template.slug,
  active: true,
  published: true,
  availability: "IN_STOCK",
  variantSummary: {
    count: 1,
    minGrossPriceMinor: 121 as number | null,
    stockOnHand: 40,
    units: ["ks"],
  },
  variantRecords: [
    {
      id: variant.id,
      sku: variant.sku,
      active: true,
      priceMinor: 100,
      grossPriceMinor: 121,
      stockOnHand: 40,
      availability: "IN_STOCK",
      minimumQuantity: 2,
      packageQuantity: 10,
      priceTiers: [{ minimumQuantity: 20, priceMinor: 110, priceExcludingVatMinor: 91 }],
    },
  ],
});
describe("OntOS source-of-truth boundary", () => {
  it("sends only purchase fields to the form without losing authoritative price or stock constraints", () => {
    const product = projectProducts({ products: [live()] }).products[0];
    const purchase = purchaseProductOf(product);
    expect(purchase.detail).toEqual({ priceTiers: product.detail.priceTiers });
    expect(purchase).not.toHaveProperty("description");
    expect(purchase).not.toHaveProperty("variantSummary");
    const variant = product.detail.variants[0];
    const compact = purchaseVariantOf(variant);
    expect(compact).toMatchObject({
      id: variant.id,
      priceMinor: variant.priceMinor,
      stockCount: variant.stockCount,
      minimumQuantity: variant.minimumQuantity,
      quantityStep: variant.quantityStep,
      priceTiers: variant.priceTiers,
      parameters: variant.parameters,
    });
    expect(compact).not.toHaveProperty("sourceId");
    expect(compact).not.toHaveProperty("isRecommended");
    expect(purchase).toMatchObject({
      priceMinor: product.priceMinor,
      stockCount: product.stockCount,
    });
  });
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
  it("projects every OntOS gallery image in staff order, not only the first two", () => {
    const p = {
      ...live(),
      gallery: [
        "https://www.akros.cz/data/product/c.jpg",
        "https://www.akros.cz/data/product/a.jpg",
        "https://www.akros.cz/data/product/b.jpg",
        "https://www.akros.cz/data/product/10091200.jpg",
        "https://www.akros.cz/data/product/a.jpg",
      ],
    };
    expect(project({ products: [p] }).catalog.products[0]).toMatchObject({
      imageSrc: "https://www.akros.cz/data/product/c.jpg",
      secondaryImageSrc: "https://www.akros.cz/data/product/a.jpg",
      additionalImageSrcs: [
        "https://www.akros.cz/data/product/a.jpg",
        "https://www.akros.cz/data/product/b.jpg",
        "https://www.akros.cz/data/product/10091200.jpg",
      ],
    });
  });
  it("never backfills an absent owner price from JSON: shows 'cena není dostupná' instead", () => {
    for (const field of ["grossPriceMinor", "priceMinor"]) {
      const p = live();
      delete (p.variantRecords[0] as Record<string, unknown>)[field];
      // The owner summary counts only priced variants and has no lowest price without a gross one.
      p.variantSummary =
        field === "priceMinor"
          ? { count: 0, minGrossPriceMinor: null, stockOnHand: 0, units: [] }
          : { ...p.variantSummary, minGrossPriceMinor: null };
      const [product] = project({ products: [p] }).catalog.products;
      expect(product.priceUnavailableReason).toBe("OntOS pro tuto položku nevrátil cenu.");
      expect(product.detail.variants[0]).toMatchObject({ priceMinor: 0, priceTiers: [] });
    }
  });
  it("treats a zero or non-CZK owner price as unavailable, with a reason", () => {
    const zero = live();
    zero.variantRecords[0].grossPriceMinor = 0;
    zero.variantRecords[0].priceMinor = 0;
    zero.variantSummary.minGrossPriceMinor = 0;
    expect(project({ products: [zero] }).catalog.products[0].priceUnavailableReason).toMatch(
      /nulová/,
    );
    const eur = { ...live(), currency: "EUR" };
    expect(project({ products: [eur] }).catalog.products[0].priceUnavailableReason).toMatch(
      /nepodporované měně \(EUR\)/,
    );
  });
  it("never derives 'skladem' from the raw ledger: UNKNOWN or untracked availability is not sellable", () => {
    for (const patch of [{ availability: "UNKNOWN" }, { availability: undefined }]) {
      const p = live();
      Object.assign(p.variantRecords[0], patch);
      Object.assign(p, patch);
      const [product] = project({ products: [p] }).catalog.products;
      expect(product.detail.variants[0]).toMatchObject({
        availabilityUnknown: true,
        stockCount: 0,
      });
      expect(product.availabilityUnknown).toBe(true);
    }
    const untracked = { ...live(), stockTracked: false };
    expect(project({ products: [untracked] }).catalog.products[0].availabilityUnknown).toBe(true);
    const simple = {
      id: "s",
      slug: "s",
      name: "S",
      active: true,
      currentPriceMinor: 100,
      grossPriceMinor: 121,
      stockOnHand: 50,
      availability: "UNKNOWN",
    };
    expect(project({ products: [simple] }).catalog.products[0]).toMatchObject({
      availabilityUnknown: true,
      stockCount: 0,
    });
  });
  it("applies owner quantity price tiers of a product without variants", () => {
    const simple = {
      id: "s",
      slug: "s",
      name: "S",
      active: true,
      currentPriceMinor: 1000,
      grossPriceMinor: 1210,
      stockOnHand: 5000,
      availability: "IN_STOCK",
      priceTiers: [
        { minimumQuantity: 1, priceMinor: 1210, priceExcludingVatMinor: 1000 },
        { minimumQuantity: 100, priceMinor: 1150, priceExcludingVatMinor: 950 },
        { minimumQuantity: 500, priceMinor: 1089, priceExcludingVatMinor: 900 },
      ],
    };
    expect(
      project({ products: [simple] }).catalog.products[0].detail.priceTiers.map(
        (tier) => tier.minimumQuantity,
      ),
    ).toEqual([1, 100, 500]);
  });
  it("sells products created in OntOS without a minimum quantity from 1 unit, like the owner", () => {
    // Shape of a product made via "Nový produkt": no variants, no minimum/package quantity.
    const created = {
      id: "fa73896a-c9d6-47f4-b092-e8f0955cd4f8",
      name: "Ověřovací produkt",
      slug: "overovaci-produkt",
      active: true,
      published: true,
      currentPriceMinor: 1000,
      grossPriceMinor: 1210,
      stockOnHand: 0,
      variantRecords: [],
    };
    const [product] = project({ products: [created] }).catalog.products;
    expect(product).toMatchObject({ priceMinor: 1210, minimumQuantity: 1, stockCount: 0 });
  });
  it("prices and stocks a listing card of a variant group from the owner's variant summary", () => {
    const { variantRecords: _records, ...card } = live();
    void _records;
    const [product] = project({
      products: [
        {
          ...card,
          grossPriceMinor: 121,
          variantSummary: { count: 3, minGrossPriceMinor: 99, stockOnHand: 75, units: ["ks"] },
        },
      ],
    }).catalog.products;
    expect(product).toMatchObject({ priceMinor: 99, stockCount: 75 });
    expect(product.detail.variants).toEqual([]);
    expect(
      createCatalog(
        { products: [product], homepageFeaturedProductIds: [] },
        { categories: [] },
      ).toProductSummary(product),
    ).toMatchObject({
      hasVariants: true,
      priceIsFrom: true,
      stock: { kind: "quantity", status: "in-stock", stockCount: 75, unit: "ks" },
    });
    const unpriced = project({
      products: [
        {
          ...card,
          variantSummary: { count: 2, minGrossPriceMinor: null, stockOnHand: 5, units: [] },
        },
      ],
    }).catalog.products[0];
    expect(unpriced).toMatchObject({
      priceMinor: 0,
      priceUnavailableReason: "OntOS pro tuto položku nevrátil cenu.",
    });
  });
  it("keeps tier net/gross values and filters inactive variants", () => {
    const p = live();
    expect(
      project({ products: [p] }).catalog.products[0].detail.variants[0].priceTiers,
    ).toContainEqual({ minimumQuantity: 20, priceMinor: 110, priceExcludingVatMinor: 91 });
    p.variantRecords[0].active = false;
    expect(project({ products: [p] }).catalog.products).toEqual([]);
  });
  it("leaves net/VAT to the OntOS quote", () => {
    const draft = { ...createCheckoutDraft(), deliveryId: "osobni" };
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
    // The browser never computes tax: net/VAT come from the server quote.
    expect(getCheckoutTotals(cart, draft, [])).toMatchObject({
      net: null,
      vat: null,
      total: 19400,
    });
  });
  it("never mutates Kai's prototype snapshot", () => {
    const before = JSON.stringify(template);
    project({ products: [live()] });
    expect(JSON.stringify(template)).toBe(before);
  });
});
