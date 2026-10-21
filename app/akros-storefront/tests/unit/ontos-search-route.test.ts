import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalog } from "@/ontos/catalog-model";
import { project } from "@/ontos/catalog-projection";
import { getCatalogPage, type CatalogPage } from "@/ontos/catalog-server";
import { POST } from "@/app/api/ontos/search/route";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/config", () => ({ isOntos: () => true }));
vi.mock("@/ontos/catalog-server", () => ({ getCatalogPage: vi.fn() }));

const snapshot = project({
  total: 37,
  page: 1,
  pageSize: 6,
  categories: [],
  products: [
    {
      id: "p1",
      slug: "sroub-din-933-a2",
      sku: "933A2",
      name: "Šroub DIN 933 A2",
      active: true,
      published: true,
      imageSrc: "/akros/products/product-02.jpg",
      variantRecords: [
        {
          id: "v1",
          sku: "933A2M8",
          name: "M8 × 20",
          active: true,
          priceMinor: 100,
          grossPriceMinor: 121,
          stockOnHand: 40,
          minimumQuantity: 1,
        },
        {
          id: "v2",
          sku: "933A2M10",
          name: "M10 × 30",
          active: true,
          priceMinor: 200,
          grossPriceMinor: 242,
          stockOnHand: 0,
          minimumQuantity: 1,
        },
      ],
    },
  ],
});
const page: CatalogPage = {
  snapshot,
  model: createCatalog(snapshot.catalog, snapshot.categories),
  products: snapshot.catalog.products,
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
});

describe("header search BFF", () => {
  it("asks OntOS for one small page and returns suggestion DTOs with the total", async () => {
    const response = await ask("  šroub ");
    expect(response.status).toBe(200);
    expect(getCatalogPage).toHaveBeenCalledWith({ q: "šroub", page: 1, pageSize: 6 });
    expect(await response.json()).toEqual({
      total: 37,
      categories: [],
      items: [
        {
          productId: "p1",
          slug: "sroub-din-933-a2",
          name: "Šroub DIN 933 A2",
          imageSrc: "/akros/products/product-02.jpg",
          currency: "CZK",
          priceMinor: 121,
          priceIsFrom: true,
          matchingVariantCount: 0,
        },
      ],
    });
  });
  it("labels an exact variant SKU match", async () => {
    const body = await (await ask("933A2M10")).json();
    expect(body.items[0]).toMatchObject({
      priceMinor: 242,
      priceIsFrom: false,
      matchingVariantCount: 1,
      variant: { sku: "933A2M10", label: "M10 × 30" },
    });
  });
  it("does not read OntOS for fewer than two characters", async () => {
    expect(await (await ask("š")).json()).toEqual({ items: [], total: 0, categories: [] });
    expect(getCatalogPage).not.toHaveBeenCalled();
  });
  it("refuses cross-origin calls", async () => {
    expect((await ask("šroub", "https://evil.example")).status).toBe(403);
  });
});
