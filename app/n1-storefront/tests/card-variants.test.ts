import { rs } from "@rstest/core";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "effect-rstest";
import { getCatalog } from "../src/ontos/catalog";
import { projectCatalog } from "../src/ontos/catalog-model";
import { readCardVariants } from "../src/ontos/card-variants-server";
import { CardVariantsQuerySchema } from "../src/ontos/card-variants";
import { GET } from "../src/app/api/card-variants/route";

rs.mock("../src/ontos/catalog", () => ({ getCatalog: rs.fn() }));
const read = rs.mocked(getCatalog);
const query = { locale: "cs", productId: "owner-product", slug: "owner-product" } as const;
const catalog = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "N1-CZ" },
    products: [
      {
        id: query.productId,
        name: "Owner product",
        slug: query.slug,
        variantRecords: [
          {
            active: true,
            attributes: "",
            availability: "IN_STOCK",
            grossPriceMinor: 100,
            id: "first",
            name: "XL",
            sku: "XL",
            stockOnHand: 2,
          },
          {
            active: false,
            attributes: "",
            availability: "IN_STOCK",
            grossPriceMinor: 100,
            id: "removed",
            name: "OLD",
            sku: "OLD",
            stockOnHand: 2,
          },
          {
            active: true,
            attributes: "",
            availability: "IN_STOCK",
            grossPriceMinor: 100,
            id: "second",
            name: "SM",
            sku: "SM",
            stockOnHand: 2,
          },
        ],
      },
    ],
  },
  [],
);

describe("card variant intent read", () => {
  beforeEach(() => {
    read.mockReset();
  });
  it.effect(
    "uses one exact full slug query and returns only real active names in owner order",
    () =>
      Effect.gen(function* readSingleSlug() {
        read.mockResolvedValue({ catalog, state: "ready" });
        expect(yield* readCardVariants(query)).toEqual({
          productId: query.productId,
          slug: query.slug,
          state: "ready",
          variants: [
            { id: "first", name: "XL" },
            { id: "second", name: "SM" },
          ],
        });
        expect(read).toHaveBeenCalledExactlyOnceWith("cs", JSON.stringify({ slug: query.slug }));
      }),
  );
  it.effect("does not substitute another product returned by the owner", () =>
    Effect.gen(function* rejectWrongProduct() {
      read.mockResolvedValue({ catalog, state: "ready" });
      expect(yield* readCardVariants({ ...query, productId: "other-product" })).toEqual({
        state: "unavailable",
      });
      expect(yield* readCardVariants({ ...query, slug: "other-slug" })).toEqual({
        state: "unavailable",
      });
    }),
  );
  it.effect("does not invent missing names from variant count or card previews", () =>
    Effect.gen(function* keepMissingNames() {
      read.mockResolvedValue({
        catalog: {
          ...catalog,
          details: catalog.details.map((product) => ({
            ...product,
            variantCount: 8,
            variants: [],
          })),
        },
        state: "ready",
      });
      expect(yield* readCardVariants(query)).toEqual({
        productId: query.productId,
        slug: query.slug,
        state: "ready",
        variants: [],
      });
    }),
  );
  it.effect("retains unavailable reads and unconfigured markets without a fabricated list", () =>
    Effect.gen(function* keepUnavailable() {
      read.mockResolvedValue({ reason: "StorefrontReadUnavailable", state: "unavailable" });
      expect(yield* readCardVariants(query)).toEqual({ state: "unavailable" });
      read.mockResolvedValue({ catalog: { ...catalog, configured: false }, state: "ready" });
      expect(yield* readCardVariants(query)).toEqual({ state: "unavailable" });
    }),
  );
  it("rejects invalid locale and unbounded identifiers", () => {
    const valid = Schema.is(CardVariantsQuerySchema);
    expect(valid(query)).toBe(true);
    expect(valid({ ...query, locale: "invalid" })).toBe(false);
    expect(valid({ ...query, slug: "" })).toBe(false);
    expect(valid({ ...query, productId: "x".repeat(301) })).toBe(false);
  });
  it("serves a no-store typed GET and rejects bad input before owner access", async () => {
    read.mockResolvedValue({ catalog, state: "ready" });
    const response = await GET(
      new Request(`https://n1.example/api/card-variants?${new URLSearchParams(query)}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      productId: query.productId,
      slug: query.slug,
      state: "ready",
      variants: [
        { id: "first", name: "XL" },
        { id: "second", name: "SM" },
      ],
    });
    read.mockClear();
    const invalid = await GET(
      new Request("https://n1.example/api/card-variants?locale=bad&slug=x&productId=x"),
    );
    expect(invalid.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });
});
