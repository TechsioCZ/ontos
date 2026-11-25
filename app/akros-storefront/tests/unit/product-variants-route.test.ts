import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/ontos/product-variants/[slug]/route";
import type { readProducts } from "@/ontos/catalog-server";
import type { CatalogProduct } from "@/ontos/catalog-types";
import { createOperation } from "@ontos/storefront-runtime";
import { fixtureProducts } from "../support/catalog-fixture";

const withVariants = fixtureProducts.find((product) => product.detail.variants.length > 1)!;
const plain: CatalogProduct = {
  ...fixtureProducts.find((product) => product.detail.variants.length === 0)!,
  netWeight: 0.25,
};
const page = (products: CatalogProduct[]) => ({
  revision: 1,
  total: products.length,
  page: 1,
  pageSize: 1,
  products,
  homepageFeaturedProductIds: [],
});
const call = (slug: string, read: typeof readProducts) =>
  GET(new Request(`https://shop.test/api/ontos/product-variants/${slug}`), {
    params: Promise.resolve({ slug }),
    read,
  });

describe("GET /api/ontos/product-variants/[slug]", () => {
  it("reads the product's full OntOS record and returns its card and variants", async () => {
    const requests: unknown[] = [];
    const response = await call(withVariants.slug, async (query, fields, fresh, options) => {
      requests.push([query, fields, fresh, options?.operation !== undefined]);
      return page([withVariants]);
    });
    expect(requests).toEqual([[{ slug: withVariants.slug, pageSize: 1 }, "full", false, true]]);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.product).toMatchObject({ id: withVariants.id, hasVariants: true });
    expect(body.variants.map((variant: { id: string }) => variant.id)).toEqual(
      withVariants.detail.variants.map((variant) => variant.id),
    );
  });

  it("presents a product without variants as its own single concrete item", async () => {
    const body = await (await call(plain.slug, async () => page([plain]))).json();
    expect(body.variants).toEqual([
      expect.objectContaining({
        id: plain.id,
        sku: plain.sku,
        priceMinor: plain.priceMinor,
        sourceNetWeight: 0.25,
      }),
    ]);
  });

  it("answers 404 for an unknown product and 503 when OntOS fails", async () => {
    expect((await call("missing", async () => page([]))).status).toBe(404);
    expect(
      (
        await call("missing", async () => {
          throw new Error("down");
        })
      ).status,
    ).toBe(503);
  });

  it("cancels the product read when the caller disconnects", async () => {
    const caller = new AbortController();
    const started = Promise.withResolvers<void>();
    const response = GET(
      new Request(`https://shop.test/api/ontos/product-variants/${plain.slug}`, {
        signal: caller.signal,
      }),
      {
        params: Promise.resolve({ slug: plain.slug }),
        read: async (_query, _fields, _fresh, options) => {
          const operation = options?.operation ?? Effect.runSync(createOperation());
          started.resolve();
          try {
            await Effect.runPromise(operation.wait(50));
            return page([plain]);
          } finally {
            if (!options?.operation) operation.dispose();
          }
        },
      },
    );
    await started.promise;
    caller.abort();
    expect((await response).status).toBe(499);
    expect(await (await response).json()).toMatchObject({ code: "cancelled" });
  });
});
