// @rstest-environment happy-dom
import "@app/shared-contracts/testing/http-double";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Schema, Struct } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import ProductPage from "../src/app/[locale]/produkt/[slug]/page";
import type { CatalogResponseSchema } from "../src/ontos/catalog-model";
import { getDictionary } from "../src/i18n";

const tenantId = "70000000-0000-4000-8000-000000000099";
const legalEntityId = "71000000-0000-4000-8000-000000000099";
const marketId = "72000000-0000-4000-8000-000000000099";
const product = {
  availability: "IN_STOCK",
  categoryId: "shirts",
  grossPriceMinor: 1200,
  id: "current",
  name: "Current owner shirt",
  slug: "current-shirt",
};
const category = { id: "shirts", name: "Shirts", parentId: null, slug: "shirts" };
const marketCatalog = {
  associations: [
    {
      channel: "B2C",
      effectivePeriod: { startsAt: "2020-01-01T00:00:00Z" },
      marketRef: { resourceId: marketId },
      sellingLegalEntityRef: { resourceId: legalEntityId },
      storefrontRef: { appId: "n1-storefront", tenantId },
    },
  ],
  markets: [
    {
      effectivePeriod: { startsAt: "2020-01-01T00:00:00Z" },
      lifecycle: "ACTIVE",
      marketCode: "N1",
      marketRef: { resourceId: marketId },
      sellingLegalEntityRef: { resourceId: legalEntityId },
      supportedLocales: ["cs-CZ", "en-GB"],
    },
  ],
};
const CatalogQuery = Schema.Struct({
  categorySlug: Schema.optionalKey(Schema.String),
  slug: Schema.optionalKey(Schema.String),
});
const GatewayRead = Schema.Struct({
  query: Schema.Struct({
    view: Schema.optionalKey(Schema.Struct({ storefrontCatalog: CatalogQuery })),
  }),
  readName: Schema.String,
});
let products: typeof CatalogResponseSchema.Encoded.products = [product];
let related: typeof CatalogResponseSchema.Encoded.products = [product];
let relatedStatus = 200;
const reads: (typeof CatalogQuery.Type)[] = [];
let previousInterceptor: typeof window.happyDOM.settings.fetch.interceptor;
const gatewayHeaders = {
  "x-ontos-gateway-context": JSON.stringify({
    apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
    compositionRevision: "a".repeat(64),
    expiresAt: 9_999_999_999,
    token: "route-test-read-assertion",
  }),
};
beforeAll(() => {
  // Exercise getCatalog, configuration, market admission and gateway decoding, not an internal catalog replacement.
  previousInterceptor = window.happyDOM.settings.fetch.interceptor;
  window.happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: async ({ request, window }) => {
      expect(request.url).toBe(
        "https://shell.example/shell-super-app-api/auth/api-key/gateway-read",
      );
      const read = Schema.decodeUnknownSync(GatewayRead)(await request.json());
      if (read.readName === "current-market-catalog") {
        return window.Response.json(marketCatalog, { headers: gatewayHeaders });
      }
      expect(read.readName).toBe("records");
      const query = read.query.view?.storefrontCatalog;
      if (query === undefined) {
        throw new Error("Expected a storefront catalog query");
      }
      reads.push(query);
      return window.Response.json(
        {
          categories: [category],
          market: { configured: true, currency: "CZK", marketId },
          products: query.categorySlug === undefined ? products : related,
        },
        {
          headers: gatewayHeaders,
          status: query.categorySlug === undefined ? 200 : relatedStatus,
        },
      );
    },
  };
});
afterAll(() => {
  window.happyDOM.settings.fetch.interceptor = previousInterceptor;
});
beforeEach(() => {
  rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "route-test-service-key");
  rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", tenantId);
  rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  rs.stubEnv("ONTOS_SHELL_URL", "https://shell.example");
  reads.length = 0;
  products = [product];
  related = [product];
  relatedStatus = 200;
});
afterEach(() => {
  rs.unstubAllEnvs();
});
const page = async (locale = "cs", variantId?: string | string[]) =>
  renderToStaticMarkup(
    await ProductPage({
      params: Promise.resolve({ locale, slug: product.slug }),
      searchParams: Promise.resolve(variantId === undefined ? {} : { variantId }),
    }),
  );

describe("PDP owner-backed route boundary", () => {
  it.each(["cs", "en"])(
    "excludes the current product and bounds real category results in %s",
    async (locale) => {
      related = [
        product,
        ...Array.from({ length: 6 }, (_, index) => ({
          ...product,
          id: `related-${index}`,
          name: `Related owner shirt ${index}`,
          slug: `related-shirt-${index}`,
        })),
      ];
      const html = await page(locale);
      expect(reads).toEqual([{ slug: product.slug }, { categorySlug: category.slug }]);
      expect(html).toContain(`href="/${locale}/produkt/related-shirt-0"`);
      expect(html).toContain(`href="/${locale}/produkt/related-shirt-3"`);
      expect(html).not.toContain(`href="/${locale}/produkt/related-shirt-4"`);
      expect(html).not.toContain(`href="/${locale}/produkt/current-shirt"`);
      expect(html).not.toContain(getDictionary(locale).empty);
    },
  );
  it.each(["cs", "en"])(
    "does not claim an empty category when its owner read fails in %s",
    async (locale) => {
      relatedStatus = 403;
      const html = await page(locale);
      expect(html).toContain(product.name);
      expect(html).toContain(getDictionary(locale).categoryLoadFailed);
      expect(html).not.toContain(getDictionary(locale).empty);
    },
  );
  it("shows empty only after a successful category read with no other product", async () => {
    expect(await page()).toContain(getDictionary("cs").empty);
    expect(reads).toHaveLength(2);
  });
  it.each([undefined, "missing-category"])(
    "does not substitute an unfiltered read for missing category %s",
    async (categoryId) => {
      products = [
        categoryId === undefined
          ? Struct.omit(product, ["categoryId"])
          : { ...product, categoryId },
      ];
      const html = await page();
      expect(reads).toEqual([{ slug: product.slug }]);
      expect(html).not.toContain('aria-labelledby="product-related-heading"');
      expect(html).not.toContain(getDictionary("cs").empty);
    },
  );
  it.each([{ selector: [] }, { selector: ["variant"] }, { selector: ["first", "second"] }])(
    "rejects a plural selector before a related read: %j",
    async ({ selector }) => {
      await expect(page("cs", selector)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(reads).toEqual([{ slug: product.slug }]);
    },
  );
  it("allows a generic owner variant without a query but blocks an explicit unknown selector", async () => {
    products = [
      {
        ...Struct.omit(product, ["categoryId"]),
        variantRecords: [
          {
            active: true,
            attributes: "",
            availability: "IN_STOCK",
            grossPriceMinor: 1210,
            id: "owner-variant",
            name: product.name,
            sku: "OWNER",
            stockOnHand: 2,
          },
        ],
        variantSummary: { count: 1, minGrossPriceMinor: 1210, stockOnHand: 2 },
      },
    ];
    const implicit = await page();
    expect(implicit).toContain('role="spinbutton"');
    expect(implicit).toContain("variantIds=owner-variant");
    expect(implicit).not.toContain(getDictionary("cs").selectVariant);
    const unknown = await page("cs", "unknown-owner-variant");
    expect(unknown).toContain(getDictionary("cs").selectVariant);
    expect(unknown).not.toContain('role="spinbutton"');
    expect(unknown).not.toContain("variantIds=");
  });
});
