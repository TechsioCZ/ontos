import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalog } from "@/ontos/catalog-model";
import { projectProducts } from "@/ontos/catalog-projection";
import { getCatalogPage, readProducts, type CatalogPage } from "@/ontos/catalog-server";
import { POST } from "@/app/api/ontos/search/route";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/catalog-server", () => ({ getCatalogPage: vi.fn(), readProducts: vi.fn() }));

// The full record of p1 (search variant routing): two variants, one with an exact SKU.
const fullP1 = projectProducts({
  total: 1,
  page: 1,
  pageSize: 2,
  products: [
    {
      id: "p1",
      slug: "sroub-din-933-a2",
      sku: "933A2",
      name: "Šroub DIN 933 A2",
      active: true,
      published: true,
      availability: "IN_STOCK",
      imageSrc: "/akros/products/product-02.jpg",
      currency: "CZK",
      grossPriceMinor: 121,
      priceMinor: 100,
      variantSummary: { count: 2, minGrossPriceMinor: 121, stockOnHand: 40, units: ["ks"] },
      variantRecords: [
        {
          id: "v1",
          sku: "933A2M6",
          name: "M6 x 20",
          grossPriceMinor: 121,
          priceMinor: 100,
          stockOnHand: 20,
        },
        {
          id: "v2",
          sku: "933A2M8",
          name: "M8 x 20",
          grossPriceMinor: 254,
          priceMinor: 210,
          stockOnHand: 20,
        },
      ],
    },
  ],
});

// A listing card: no variant records, only the owner's variant summary.
const listing = projectProducts({
  total: 37,
  page: 1,
  pageSize: 6,
  products: [
    {
      id: "p1",
      slug: "sroub-din-933-a2",
      sku: "933A2",
      name: "Šroub DIN 933 A2",
      active: true,
      published: true,
      availability: "IN_STOCK",
      imageSrc: "/akros/products/product-02.jpg",
      grossPriceMinor: 121,
      variantSummary: { count: 2, minGrossPriceMinor: 121, stockOnHand: 40, units: ["ks"] },
    },
  ],
});
const page: CatalogPage = {
  model: createCatalog(listing, {
    categories: [
      { id: "c1", parentId: null, hasChildren: true, slug: "srouby", name: "Šrouby", position: 1 },
      {
        id: "c2",
        parentId: "c1",
        hasChildren: false,
        slug: "din-933",
        name: "Šrouby DIN 933",
        position: 1,
      },
    ],
  }),
  products: listing.products,
  total: 37,
  page: 1,
  pageSize: 6,
};
const ask = (q: unknown, origin = "http://localhost:3070") =>
  POST(
    new Request("http://localhost:3070/api/ontos/search", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ q }),
    }),
  );

beforeEach(() => {
  vi.mocked(getCatalogPage).mockReset();
  vi.mocked(getCatalogPage).mockResolvedValue(page);
  vi.mocked(readProducts).mockReset();
  vi.mocked(readProducts).mockResolvedValue(fullP1);
});

describe("header search BFF", () => {
  it("asks OntOS for one small page and returns suggestion DTOs with the total", async () => {
    const response = await ask("  šroub ");
    expect(response.status).toBe(200);
    expect(getCatalogPage).toHaveBeenCalledWith({ q: "šroub", page: 1, pageSize: 6 });
    expect(await response.json()).toEqual({
      total: 37,
      categories: [
        { id: "c1", slug: "srouby", name: "Šrouby", trail: "" },
        { id: "c2", slug: "din-933", name: "Šrouby DIN 933", trail: "Šrouby" },
      ],
      items: [
        {
          productId: "p1",
          slug: "sroub-din-933-a2",
          name: "Šroub DIN 933 A2",
          imageSrc: "/akros/products/product-02.jpg",
          currency: "CZK",
          priceMinor: 121,
          priceIsFrom: true,
          hasVariants: true,
          path: "/produkt/sroub-din-933-a2",
        },
      ],
    });
  });
  it("routes an exact variant SKU to that variant with its own price", async () => {
    const body = (await (await ask("933a2m8")).json()) as { items: unknown[] };
    expect(readProducts).toHaveBeenCalledWith({ productIds: ["p1"], pageSize: 1 }, "full");
    expect(body.items).toEqual([
      expect.objectContaining({
        priceMinor: 254,
        priceIsFrom: false,
        variantLabel: "M8 x 20",
        variantSku: "933A2M8",
        path: "/produkt/sroub-din-933-a2?variantIds=v2#product-variants",
      }),
    ]);
  });
  it("keeps the query-filtered table when the variant read fails", async () => {
    vi.mocked(readProducts).mockRejectedValue(new Error("OntOS down"));
    const body = (await (await ask("M8")).json()) as { items: unknown[] };
    expect(body.items).toEqual([
      expect.objectContaining({
        priceIsFrom: true,
        path: "/produkt/sroub-din-933-a2?variant=M8#product-variants",
      }),
    ]);
  });
  it("does not read OntOS for fewer than two characters", async () => {
    expect(await (await ask("š")).json()).toEqual({ items: [], total: 0, categories: [] });
    expect(getCatalogPage).not.toHaveBeenCalled();
  });
  it("refuses cross-origin calls", async () => {
    expect((await ask("šroub", "https://evil.example")).status).toBe(403);
  });
});
