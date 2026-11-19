// @rstest-environment happy-dom
import { browserNetwork, networkIdle } from "@app/shared-contracts/testing/http-double";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@modern-js/bff-effect/effect-edge";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect } from "@rstest/core";
import { Effect, Schema } from "effect";
import { it } from "effect-rstest";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import ContentPage from "../src/app/[locale]/[content]/page";
import { getDictionary } from "../src/i18n";
import type { CatalogResponseSchema } from "../src/ontos/catalog-model";
import type { FulfillmentSnapshotSchema } from "../src/ontos/fulfillment-model";

const tenantId = "70000000-0000-4000-8000-000000000099";
const legalEntityId = "71000000-0000-4000-8000-000000000099";
const marketId = "72000000-0000-4000-8000-000000000099";
const englishMarketId = "72000000-0000-4000-8000-000000000098";
const markets = [
  { id: marketId, locale: "cs-CZ" },
  { id: englishMarketId, locale: "en-GB" },
];
const product = {
  id: "product",
  name: "Actual owner product",
  slug: "actual",
  variantRecords: [
    {
      active: true,
      attributes: "",
      availability: "IN_STOCK",
      grossPriceMinor: 1200,
      id: "n1legacy:variant:12",
      name: "M",
      sku: "ACTUAL-M",
      stockOnHand: 2,
    },
  ],
} satisfies (typeof CatalogResponseSchema.Encoded.products)[number];
const marketCatalog = {
  associations: markets.map(({ id }) => ({
    channel: "B2C",
    effectivePeriod: { startsAt: "2020-01-01T00:00:00Z" },
    marketRef: { resourceId: id },
    sellingLegalEntityRef: { resourceId: legalEntityId },
    storefrontRef: { appId: "n1-storefront", tenantId },
  })),
  markets: markets.map(({ id, locale }) => ({
    effectivePeriod: { startsAt: "2020-01-01T00:00:00Z" },
    lifecycle: "ACTIVE",
    marketCode: `N1-${locale}`,
    marketRef: { resourceId: id },
    sellingLegalEntityRef: { resourceId: legalEntityId },
    supportedLocales: [locale],
  })),
};
const fulfillment = {
  checkout: {
    carrierTrackingAvailable: false,
    paymentAvailable: false,
    shippingMethods: [{ id: "PPL", priceMinor: 12_900, title: "Owner PPL delivery" }],
  },
  market: { configured: true, currency: "CZK", marketId: englishMarketId },
} satisfies typeof FulfillmentSnapshotSchema.Encoded;
const GatewayRead = Schema.Struct({
  audience: Schema.String,
  legalEntityId: Schema.String,
  query: Schema.Struct({
    at: Schema.optionalKey(Schema.String),
    view: Schema.optionalKey(
      Schema.Struct({
        storefront: Schema.Boolean,
        storefrontCatalog: Schema.Struct({
          fields: Schema.optionalKey(Schema.String),
          includeCategories: Schema.Boolean,
          marketId: Schema.String,
          mode: Schema.optionalKey(Schema.String),
          pageSize: Schema.optionalKey(Schema.Number),
          productIds: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
        storefrontCheckout: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
  readName: Schema.String,
});
const reads: (typeof GatewayRead.Type)[] = [];
const serverErrors: unknown[] = [];
let products: typeof CatalogResponseSchema.Encoded.products = [product];
let catalogStatus = 200;
const owner = HttpRouter.add(
  "POST",
  "/shell-super-app-api/auth/api-key/gateway-read",
  Effect.gen(function* answerGatewayRead() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    expect(request.headers["x-api-key"]).toBe("legal-route-service-key");
    const read = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(GatewayRead)));
    reads.push(read);
    expect(read.legalEntityId).toBe(legalEntityId);
    const headers = {
      "x-ontos-gateway-context": JSON.stringify({
        apiBaseUrl: `/shell-super-app-api/gateway/${read.audience}`,
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: "legal-route-read-assertion",
      }),
    };
    if (read.readName === "current-market-catalog") {
      expect(read.audience).toBe("commerce-market-catalog");
      return HttpServerResponse.jsonUnsafe(marketCatalog, { headers });
    }
    expect(read.readName).toBe("records");
    expect(read.audience).toBe("merchandise");
    if (read.query.view?.storefrontCheckout === true) {
      return HttpServerResponse.jsonUnsafe(fulfillment, { headers });
    }
    return HttpServerResponse.jsonUnsafe(
      { market: { configured: true, currency: "CZK", marketId }, products },
      { headers, status: catalogStatus },
    );
  }).pipe(
    Effect.tapDefect((cause) =>
      Effect.sync(() => {
        serverErrors.push(cause);
      }),
    ),
    Effect.orDie,
  ),
);
const environment = {
  ONTOS_N1_STOREFRONT_API_KEY: "legal-route-service-key",
  ONTOS_SHELL_URL: "https://shell.example",
  ONTOS_STOREFRONT_LEGAL_ENTITY_ID: legalEntityId,
  ONTOS_STOREFRONT_TENANT_ID: tenantId,
};
const previousEnvironment = Object.keys(environment).map((key) => [key, process.env[key]] as const);
beforeAll(() => {
  Object.assign(process.env, environment);
});
afterAll(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
});
beforeEach(() => {
  reads.length = 0;
  serverErrors.length = 0;
  products = [product];
  catalogStatus = 200;
});
const serverNavigation = () => {
  throw new Error("Navigation must not run during server rendering");
};
const router = {
  back: serverNavigation,
  bfcacheId: "legal-routes",
  forward: serverNavigation,
  prefetch: serverNavigation,
  push: serverNavigation,
  refresh: serverNavigation,
  replace: serverNavigation,
} satisfies AppRouterInstance;
const localeParams = { cs: { locale: "cs" }, en: { locale: "en" } };
const renderPage = (
  content: string,
  locale: keyof typeof localeParams = "cs",
  query: { productId?: string | string[]; variantIds?: string | string[] } = {},
) =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: async () =>
      renderToStaticMarkup(
        <AppRouterContext.Provider value={router}>
          <PathParamsContext.Provider value={localeParams[locale]}>
            {await ContentPage({
              params: Promise.resolve({ content, locale }),
              searchParams: Promise.resolve(query),
            })}
          </PathParamsContext.Provider>
        </AppRouterContext.Provider>,
      ),
  }).pipe(
    Effect.ensuring(
      networkIdle.pipe(
        Effect.andThen(
          Effect.sync(() => {
            expect(serverErrors).toEqual([]);
          }),
        ),
      ),
    ),
    Effect.provide(browserNetwork(owner)),
  );
const renderContact = (query: { productId?: string | string[]; variantIds?: string | string[] }) =>
  renderPage("kontakty", "cs", query);
const ownerReads = () => reads.filter((read) => read.readName === "records");

describe("contact product selectors fail closed at the route boundary", () => {
  it.live("reads the real selected identity and passes only canonical prefill to ContactView", () =>
    Effect.gen(function* canonicalContactPrefill() {
      const html = yield* renderContact({
        productId: "product",
        variantIds: "n1legacy:variant:12",
      });
      const d = getDictionary("cs");
      expect(html).toContain(d.contact.formHeading);
      expect(reads).toHaveLength(2);
      expect(ownerReads()).toHaveLength(1);
      expect(ownerReads()[0]?.query.view?.storefrontCatalog).toEqual({
        fields: "full",
        includeCategories: false,
        marketId,
        pageSize: 1,
        productIds: ["product"],
      });
      expect(html).toContain(d.contact.productLine.replace("{name}", product.name));
      expect(html).toContain(
        d.contact.variantLine.replace("{name}", "M").replace("{sku}", "ACTUAL-M"),
      );
      expect(html).toContain(d.contact.productQuestionPrompt);
      expect(html).not.toContain(d.contact.formUnavailable);
    }),
  );
  it.live("shows a locked unavailable question rather than reverting to a generic contact", () =>
    Effect.gen(function* unavailableContact() {
      catalogStatus = 403;
      const html = yield* renderContact({ productId: "product" });
      expect(html).toContain(getDictionary("cs").contact.formHeading);
      expect(html).toContain(getDictionary("cs").contact.formUnavailable);
      expect(html).toMatch(/<fieldset\b[^>]*disabled=""/u);
      expect(html).not.toContain(product.name);
      expect(ownerReads()).toHaveLength(1);
    }),
  );
  it.live(
    "returns not-found for a product or variant that the public catalog no longer exposes",
    () =>
      Effect.gen(function* removedVariant() {
        const failure = yield* Effect.flip(
          renderContact({ productId: "product", variantIds: "removed" }),
        );
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toHaveProperty("message", expect.stringMatching(/404/u));
        expect(ownerReads()).toHaveLength(1);
      }),
  );
  it.live.each([
    { productId: ["product", "other"] },
    { variantIds: "variant" },
    { productId: "product", variantIds: "first,second" },
  ])("rejects invalid selectors before performing a catalog read", (query) =>
    Effect.gen(function* invalidSelector() {
      const failure = yield* Effect.flip(renderContact(query));
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toHaveProperty("message", expect.stringMatching(/404/u));
      expect(reads).toEqual([]);
    }),
  );
});

describe("legal routes retain the existing content dispatch boundary", () => {
  it.live.each(["obchodni-podminky", "ochrana-osobnich-udaju"])(
    "renders the same authored Czech document on both site locales: %s",
    (slug) =>
      Effect.gen(function* authoredLegalDocument() {
        const czech = yield* renderPage(slug, "cs");
        const english = yield* renderPage(slug, "en");
        expect(english).toBe(czech);
        expect(english).toContain('lang="cs"');
        expect(english).not.toContain(getDictionary("en").featureUnavailable);
        expect(reads).toEqual([]);
      }),
  );
  it.live("leaves the unimplemented news content as an explicit placeholder", () =>
    Effect.gen(function* newsPlaceholder() {
      const html = yield* renderPage("novinky");
      expect(html).toContain(getDictionary("cs").featureUnavailable);
      expect(html).not.toContain("N Distribution s.r.o.");
      expect(reads).toEqual([]);
    }),
  );
  it.live.each(["unpublished-page", "zasady-ochrany-osobnich-udaju"])(
    "preserves unknown-slug 404 rather than inventing a CMS page: %s",
    (slug) =>
      Effect.gen(function* unknownContent() {
        const failure = yield* Effect.flip(renderPage(slug));
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toHaveProperty("message", expect.stringMatching(/404/u));
        expect(reads).toEqual([]);
      }),
  );
  it.live.each(["prihlaseni", "registrace", "kontakty"])(
    "preserves the existing %s dispatch",
    (slug) =>
      Effect.gen(function* existingDispatch() {
        const html = yield* renderPage(slug);
        const d = getDictionary("cs");
        if (slug === "kontakty") {
          expect(html).toContain(d.contact.formHeading);
          expect(html).toContain('name="message"');
          expect(html).not.toContain(d.contact.formUnavailable);
        } else {
          expect(html).toContain(slug === "registrace" ? d.auth.register : d.auth.signIn);
          expect(html).toContain('name="email"');
          expect(html).toContain(
            `action="${slug === "registrace" ? "/api/enrollment" : "/api/account/login"}"`,
          );
        }
        expect(reads).toEqual([]);
      }),
  );
  it.live.each(["doprava", "platba"])("preserves the real fulfillment read for %s", (slug) =>
    Effect.gen(function* englishFulfillment() {
      const html = yield* renderPage(slug, "en");
      const d = getDictionary("en");
      expect(html).toContain(slug === "doprava" ? d.shipping : d.payment);
      expect(html).toContain(slug === "doprava" ? "Owner PPL delivery" : d.fulfillment.noPayment);
      expect(html).not.toContain(d.fulfillment.unavailable);
      expect(reads).toHaveLength(2);
      expect(ownerReads()).toHaveLength(1);
      expect(ownerReads()[0]?.query.view).toEqual({
        storefront: true,
        storefrontCatalog: {
          includeCategories: false,
          marketId: englishMarketId,
          mode: "categories",
        },
        storefrontCheckout: true,
      });
    }),
  );
});
