import { describe, it, expect } from "vitest";
import { imagePlaceholder } from "@/ontos/media-path";
import {
  projectCategories,
  projectProducts,
  purchaseProductOf,
  purchaseVariantOf,
  CatalogSearchMatchError,
} from "@/ontos/catalog-projection";
import raw from "@/catalog-import/generated/catalog.generated.json";
import { createCatalog } from "@/ontos/catalog-model";
import { createCheckoutDraft, getCheckoutTotals } from "@/features/checkout/checkout-state";
import { cs } from "@/i18n/cs";
import {
  matchSearchVariants,
  toRemoteSuggestion,
  toSearchGridItem,
} from "@/ontos/search-suggestions";
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
  it("does not impose parent minimum or packaging on an unpackaged variant", () => {
    const product = live();
    const {
      minimumQuantity: _minimum,
      packageQuantity: _pack,
      ...ownVariant
    } = product.variantRecords[0];
    const projected = projectProducts({
      products: [
        {
          ...product,
          minimumQuantity: 20,
          packageQuantity: 10,
          variantRecords: [{ ...ownVariant, stockOnHand: 5 }],
        },
      ],
    }).products[0];
    expect(projected.detail.variants[0]).toMatchObject({
      minimumQuantity: 1,
      quantityStep: 1,
      stockCount: 5,
    });
    expect(projected.detail.variants[0].packageQuantity).toBeUndefined();
    expect(projected.minimumQuantity).toBe(1);
    expect(projected.packageQuantity).toBeUndefined();
  });
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
  it("serves the placeholder stored under its original path from the brand-neutral path", () => {
    const p = { ...live(), imageSrc: "/akros/products/image-unavailable.svg", gallery: [] };
    expect(project({ products: [p] }).catalog.products[0].imageSrc).toBe(
      "/storefront/products/image-unavailable.svg",
    );
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
      expect(product.priceUnavailableReason).toBe("missing-price");
      expect(product.detail.variants[0]).toMatchObject({ priceMinor: 0, priceTiers: [] });
    }
  });
  it("treats a zero or non-CZK owner price as unavailable, with a reason", () => {
    const zero = live();
    zero.variantRecords[0].grossPriceMinor = 0;
    zero.variantRecords[0].priceMinor = 0;
    zero.variantSummary.minGrossPriceMinor = 0;
    expect(project({ products: [zero] }).catalog.products[0].priceUnavailableReason).toBe(
      "zero-price",
    );
    const eur = { ...live(), currency: "EUR" };
    expect(project({ products: [eur] }).catalog.products[0].priceUnavailableReason).toBe(
      "currency:EUR",
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
      priceUnavailableReason: "missing-price",
    });
  });
  it("serves variant photos from the parent product's gallery and keeps /obrazky category images", () => {
    const asset = "0b6b0c7e-1f2a-4c3d-8e9f-a0b1c2d3e4f5";
    const p = live();
    const body = {
      products: [
        { ...p, variantRecords: [{ ...p.variantRecords[0], imageSrc: `media:${asset}` }] },
      ],
      categories: [
        { id: "c1", slug: "srouby", name: "Šrouby", imageSrc: `/obrazky/${p.id}/${asset}` },
      ],
    };
    const projected = project(body);
    expect(projected.catalog.products[0].detail.variants[0].imageSrc).toBe(
      `/obrazky/${encodeURIComponent(p.id)}/${asset}`,
    );
    expect(projected.categories.categories[0].imageSrc).toBe(`/obrazky/${p.id}/${asset}`);
  });
  it("keeps tier net/gross values and filters inactive variants", () => {
    const p = live();
    expect(
      project({ products: [p] }).catalog.products[0].detail.variants[0].priceTiers,
    ).toContainEqual({
      minimumQuantity: 20,
      priceMinor: 110,
      priceExcludingVatMinor: 91,
    });
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

describe("compact owner search evidence", () => {
  // Synthetic owner offer: these are supplied facts, never reconstructed from a group/card price.
  const offer = () => ({
    id: "item-6692",
    name: "Varianta z vlastníka",
    sku: "10799700035016",
    currency: "CZK",
    grossPriceMinor: 254,
    priceMinor: 210,
    displayPriceExcludingVatMinor: 207,
    availability: "IN_STOCK",
    stockOnHand: 13.5,
    unit: "ks",
    minimumQuantity: 2,
    packageQuantity: 10,
    imageSrc: "media:0b6b0c7e-1f2a-4c3d-8e9f-a0b1c2d3e4f5",
  });
  const card = () => ({
    ...live(),
    currency: "CZK",
    minimumQuantity: 200,
    packageQuantity: 100,
    variantRecords: undefined,
    variantSummary: { count: 47, minGrossPriceMinor: 121, stockOnHand: 500, units: ["ks"] },
  });
  const summary = (product: ReturnType<typeof projectProducts>["products"][number]) =>
    createCatalog(
      { products: [product], homepageFeaturedProductIds: [] },
      { categories: [] },
    ).toProductSummary(product);

  it.each(["CZK", "EUR", "PLN"])(
    "preserves full-leaf header/grid presentation in %s without full records",
    (currency) => {
      const leaf = { ...offer(), currency };
      const product = { ...card(), currency };
      const market = { marketId: "owner-market", currency, configured: true };
      const full = projectProducts({
        market,
        products: [
          {
            ...product,
            variantRecords: [
              {
                ...leaf,
                active: true,
                priceTiers: [{ minimumQuantity: 2, priceMinor: 254, priceExcludingVatMinor: 207 }],
              },
            ],
          },
        ],
      }).products[0];
      const compact = projectProducts({
        market,
        products: [
          {
            ...product,
            searchMatch: { kind: "single", variant: leaf },
          },
        ],
      }).products[0];
      const legacyMatch = matchSearchVariants(full, leaf.sku);
      expect(toRemoteSuggestion(compact, leaf.sku, compact.searchMatch)).toEqual(
        toRemoteSuggestion(full, leaf.sku, legacyMatch),
      );
      expect(toSearchGridItem(summary(compact), leaf.sku, cs, compact.searchMatch)).toEqual(
        toSearchGridItem(summary(full), leaf.sku, cs, legacyMatch),
      );
      expect(compact.searchMatch).toMatchObject({
        kind: "single",
        variant: {
          id: leaf.id,
          label: leaf.name,
          sku: leaf.sku,
          currency,
          priceMinor: 254,
          priceExcludingVatMinor: 207,
          stockCount: 13.5,
          minimumQuantity: 10,
          packageQuantity: 10,
          quantityStep: 10,
          imageSrc: `/obrazky/${encodeURIComponent(product.id)}/0b6b0c7e-1f2a-4c3d-8e9f-a0b1c2d3e4f5`,
        },
      });
      expect(compact.detail.variants).toEqual([]);
      expect(compact.searchMatch).not.toHaveProperty("variant.priceTiers");
      expect(compact.searchMatch).not.toHaveProperty("variant.parameters");
    },
  );

  it("uses the owner post-dedup display-net scalar, including absence, without recomputing VAT", () => {
    for (const display of [0, 67, undefined]) {
      const product = projectProducts({
        products: [
          {
            ...card(),
            searchMatch: {
              kind: "single",
              variant: { ...offer(), displayPriceExcludingVatMinor: display },
            },
          },
        ],
      }).products[0];
      expect(
        toSearchGridItem(summary(product), "leaf", cs, product.searchMatch).priceExcludingVatMinor,
      ).toBe(display);
    }
  });

  it.each([
    { availability: "UNKNOWN", stockOnHand: 500, stockCount: 0, status: "unknown" },
    { availability: "OUT_OF_STOCK", stockOnHand: 500, stockCount: 0, status: "out-of-stock" },
    { availability: "LOW_STOCK", stockOnHand: 5, stockCount: 5, status: "limited-stock" },
    { availability: "IN_STOCK", stockOnHand: -1, stockCount: 0, status: "out-of-stock" },
    { availability: "IN_STOCK", stockOnHand: 11.5, stockCount: 11.5, status: "in-stock" },
  ])(
    "retains stock semantics for $availability / $stockOnHand",
    ({ availability, stockOnHand, stockCount, status }) => {
      const product = projectProducts({
        products: [
          {
            ...card(),
            searchMatch: {
              kind: "single",
              variant: { ...offer(), availability, stockOnHand },
            },
          },
        ],
      }).products[0];
      expect(
        toSearchGridItem(summary(product), "leaf", cs, product.searchMatch).stock,
      ).toMatchObject({
        kind: "quantity",
        stockCount,
        status,
        minimumQuantity: 10,
        quantityStep: 10,
      });
    },
  );

  it("retains untracked stock, zero-price, source-unit precedence and unpackaged minimum rules", () => {
    const product = projectProducts({
      products: [
        {
          ...card(),
          stockTracked: false,
          searchMatch: {
            kind: "single",
            variant: {
              ...offer(),
              grossPriceMinor: 0,
              priceMinor: 0,
              minimumQuantity: undefined,
              packageQuantity: undefined,
              sourceUnit: "m",
            },
          },
        },
      ],
    }).products[0];
    const suggestion = toRemoteSuggestion(product, "leaf", product.searchMatch);
    const grid = toSearchGridItem(summary(product), "leaf", cs, product.searchMatch);
    expect(suggestion).toMatchObject({
      priceMinor: 0,
      priceUnavailableReason: "zero-price",
      variantLabel: offer().name,
    });
    expect(grid).toMatchObject({
      priceMinor: 0,
      priceUnavailableReason: "zero-price",
      stock: {
        kind: "quantity",
        status: "unknown",
        stockCount: 0,
        minimumQuantity: 1,
        quantityStep: 1,
        unit: "m",
      },
    });
    expect(grid.priceExcludingVatMinor).toBeUndefined();
    expect(grid.stock).not.toHaveProperty("packageQuantity", 100);
  });

  it.each(["https://evil.example/x.jpg", "http://www.akros.cz/data/x.jpg", "//evil.example/x"])(
    "retains the safe parent image fallback for %s",
    (imageSrc) => {
      const product = projectProducts({
        products: [
          {
            ...card(),
            imageSrc: "/storefront/parent.jpg",
            searchMatch: {
              kind: "single",
              variant: { ...offer(), imageSrc },
            },
          },
        ],
      }).products[0];
      expect(toRemoteSuggestion(product, "leaf", product.searchMatch).imageSrc).toBe(
        "/storefront/parent.jpg",
      );
    },
  );

  it.each(["product", "unattributed"])(
    "uses a true onlyVariant for header presentation only (%s)",
    (kind) => {
      const product = projectProducts({
        products: [
          {
            ...card(),
            variantSummary: { ...card().variantSummary, count: 1 },
            searchMatch: { kind, onlyVariant: offer() },
          },
        ],
      }).products[0];
      expect(toRemoteSuggestion(product, "query", product.searchMatch)).toMatchObject({
        variantSku: offer().sku,
        variantLabel: offer().name,
        priceMinor: 254,
        path: `/produkt/${product.slug}`,
      });
      const grid = toSearchGridItem(summary(product), "query", cs, product.searchMatch);
      expect(grid).toMatchObject({ priceMinor: 121, detailHref: `/produkt/${product.slug}` });
      expect(grid.variantId).toBeUndefined();
      expect(grid.searchMatchLabel).toBeUndefined();
    },
  );

  it("preserves complete multi-match counts and known-zero unattributed routing", () => {
    for (const match of [
      { kind: "multiple", count: 47 },
      { kind: "unattributed" },
      { kind: "product" },
    ]) {
      const product = projectProducts({ products: [{ ...card(), searchMatch: match }] })
        .products[0];
      const grid = toSearchGridItem(summary(product), "query", cs, product.searchMatch);
      expect(grid.detailHref).toBe(
        match.kind === "multiple"
          ? `/produkt/${product.slug}?variant=query#product-variants`
          : `/produkt/${product.slug}`,
      );
      expect(grid.searchMatchLabel).toBe(
        match.kind === "multiple" ? cs.search.matchingVariants(47) : undefined,
      );
      expect(grid.variantId).toBeUndefined();
    }
  });

  it("does not truncate unrelated full-detail variant arrays or grant purchase authority", () => {
    const variants = Array.from({ length: 47 }, (_, index) => ({
      ...offer(),
      id: `fixture-leaf-${index}`,
      active: true,
    }));
    const product = projectProducts({ products: [{ ...card(), variantRecords: variants }] })
      .products[0];
    expect(product.detail.variants.map(({ id }) => id)).toEqual(variants.map(({ id }) => id));
    expect(purchaseProductOf(product)).not.toHaveProperty("searchMatch");
  });

  const malformed: [string, () => unknown][] = [
    ["unknown kind", () => ({ kind: "group" })],
    ["array", () => []],
    ["null", () => null],
    ["missing singleton", () => ({ kind: "single" })],
    ["singleton array", () => ({ kind: "single", variant: [offer()] })],
    ["empty identity", () => ({ kind: "single", variant: { ...offer(), id: "" } })],
    ["wrong currency", () => ({ kind: "single", variant: { ...offer(), currency: "EUR" } })],
    ["unsupported currency", () => ({ kind: "single", variant: { ...offer(), currency: "USD" } })],
    ["missing net", () => ({ kind: "single", variant: { ...offer(), priceMinor: undefined } })],
    ["negative gross", () => ({ kind: "single", variant: { ...offer(), grossPriceMinor: -1 } })],
    ["fractional money", () => ({ kind: "single", variant: { ...offer(), priceMinor: 1.5 } })],
    [
      "invalid display net",
      () => ({ kind: "single", variant: { ...offer(), displayPriceExcludingVatMinor: NaN } }),
    ],
    ["unknown stock", () => ({ kind: "single", variant: { ...offer(), stockOnHand: Infinity } })],
    [
      "invalid availability",
      () => ({ kind: "single", variant: { ...offer(), availability: "YES" } }),
    ],
    ["invalid minimum", () => ({ kind: "single", variant: { ...offer(), minimumQuantity: "2" } })],
    ["invalid optional unit", () => ({ kind: "single", variant: { ...offer(), sourceUnit: 3 } })],
    ["raw tiers", () => ({ kind: "single", variant: { ...offer(), priceTiers: [] } })],
    ["multiple singleton", () => ({ kind: "multiple", count: 1 })],
    ["fractional count", () => ({ kind: "multiple", count: 2.5 })],
    ["overcount", () => ({ kind: "multiple", count: 48 })],
    ["arbitrary onlyVariant", () => ({ kind: "product", onlyVariant: offer() })],
    ["mixed branches", () => ({ kind: "multiple", count: 2, variant: offer() })],
  ];
  it.each(malformed)("rejects malformed evidence: %s", (_name, makeMatch) => {
    expect(() => projectProducts({ products: [{ ...card(), searchMatch: makeMatch() }] })).toThrow(
      CatalogSearchMatchError,
    );
  });
  it("rejects malformed/unconfigured market evidence rather than falling back to CZK", () => {
    for (const market of [
      { marketId: "m", currency: "USD" },
      { marketId: "m", currency: "CZK", configured: false },
    ])
      expect(() =>
        projectProducts({
          market,
          products: [{ ...card(), searchMatch: { kind: "single", variant: offer() } }],
        }),
      ).toThrow(CatalogSearchMatchError);
  });
  it("requires the only-variant offer for a one-variant product-level hit instead of dropping its presentation", () => {
    expect(() =>
      projectProducts({
        products: [
          {
            ...card(),
            variantSummary: { ...card().variantSummary, count: 1 },
            searchMatch: { kind: "product" },
          },
        ],
      }),
    ).toThrow(CatalogSearchMatchError);
  });
  it("never shows a compare-at price on a single-variant card, even when the product card carries one", () => {
    // The owner search offer has no compare-at field, so one variant never inherits the product-level price.
    const product = projectProducts({
      products: [{ ...card(), searchMatch: { kind: "single", variant: offer() } }],
    }).products[0];
    const grid = toSearchGridItem(
      { ...summary(product), originalPriceMinor: 330 },
      "leaf",
      cs,
      product.searchMatch,
    );
    expect(grid).toMatchObject({ variantId: offer().id, priceMinor: 254 });
    expect(grid.originalPriceMinor).toBeUndefined();
  });
});
