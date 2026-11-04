import { describe, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { FetchHttpClient } from "effect/http";
import { readFulfillment } from "../src/ontos/fulfillment";
import { Effect, Result, Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { FulfillmentSnapshotSchema, projectFulfillment } from "../src/ontos/fulfillment-model";
import { FulfillmentView } from "../src/features/fulfillment-view";
import { getDictionary } from "../src/i18n";

rs.mock("next/navigation", () => ({ useRouter: () => ({ refresh: rs.fn() }) }));

const marketId = "83f5c73d-8e38-5d55-b4f6-8081a512cad9";
const snapshot = {
  checkout: {
    carrierTrackingAvailable: false,
    paymentAvailable: false,
    shippingMethods: [{ id: "PPL", priceMinor: 12_900, title: "PPL – doručení na adresu" }],
  },
  market: { configured: true, currency: "CZK", marketCode: "N1-CZ", marketId },
} satisfies typeof FulfillmentSnapshotSchema.Encoded;
const project = (input: typeof FulfillmentSnapshotSchema.Encoded) =>
  Schema.decodeUnknownEffect(FulfillmentSnapshotSchema)(input).pipe(
    Effect.flatMap((body) => projectFulfillment(body, marketId)),
  );

describe("governed fulfillment read", () => {
  it.effect(
    "resolves the locale market and requests no products while preserving owner currency",
    () =>
      Effect.gen(function* scopedRead() {
        const config = {
          apiKey: "test-only-service-key",
          appId: "n1-storefront",
          legalEntityId: "71000000-0000-4000-8000-000000000099",
          shellUrl: "https://shell.example",
          tenantId: "70000000-0000-4000-8000-000000000099",
        };
        const reference = { resourceId: marketId };
        const period = { startsAt: "1970-01-01T00:00:00.000Z" };
        const catalog = {
          associations: [
            {
              channel: "B2C",
              effectivePeriod: period,
              marketRef: reference,
              sellingLegalEntityRef: { resourceId: config.legalEntityId },
              storefrontRef: { appId: config.appId, tenantId: config.tenantId },
            },
          ],
          markets: [
            {
              effectivePeriod: period,
              lifecycle: "ACTIVE",
              marketCode: "N1-EN",
              marketRef: reference,
              sellingLegalEntityRef: { resourceId: config.legalEntityId },
              supportedLocales: ["en-GB"],
            },
          ],
        };
        const requests: Request[] = [];
        const fetch: typeof globalThis.fetch = (url, init) => {
          const index = requests.length;
          requests.push(new Request(url, init));
          return Promise.resolve(
            Response.json(
              index === 0
                ? catalog
                : { ...snapshot, market: { ...snapshot.market, currency: "EUR" } },
              {
                headers: {
                  "x-ontos-gateway-context": JSON.stringify({
                    apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
                    compositionRevision: "a".repeat(64),
                    expiresAt: 9_999_999_999,
                    token: "test-redeemed-token",
                  }),
                },
              },
            ),
          );
        };
        const info = yield* readFulfillment(config, "en").pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        );
        expect(info.currency).toBe("EUR");
        expect(info.shippingMethods[0]?.priceMinor).toBe(12_900);
        expect(requests).toHaveLength(2);
        const request = requests.at(1);
        const body = request === undefined ? null : yield* Effect.promise(() => request.json());
        expect(body).toMatchObject({
          audience: "merchandise",
          legalEntityId: config.legalEntityId,
          query: {
            view: {
              storefront: true,
              storefrontCatalog: { includeCategories: false, marketId, mode: "categories" },
              storefrontCheckout: true,
            },
          },
          readName: "records",
        });
      }),
  );
});

describe("market-scoped fulfillment information", () => {
  it.effect("uses only owner offers and retains their gross price", () =>
    Effect.gen(function* actualOffers() {
      const info = yield* project(snapshot);
      expect(info.shippingMethods).toEqual(snapshot.checkout.shippingMethods);
      expect(info.paymentAvailable).toBe(false);
      expect(info.currency).toBe("CZK");
    }),
  );
  it.effect.each([
    { ...snapshot, market: { ...snapshot.market, configured: false } },
    { ...snapshot, market: { ...snapshot.market, marketId: "another-market" } },
    { market: snapshot.market },
    {
      ...snapshot,
      checkout: {
        ...snapshot.checkout,
        shippingMethods: [
          snapshot.checkout.shippingMethods[0],
          snapshot.checkout.shippingMethods[0],
        ],
      },
    },
    {
      ...snapshot,
      checkout: {
        ...snapshot.checkout,
        shippingMethods: [{ id: "PPL", priceMinor: 12_900, title: " " }],
      },
    },
    {
      ...snapshot,
      checkout: {
        ...snapshot.checkout,
        shippingMethods: [{ id: "PPL", priceMinor: -1, title: "PPL" }],
      },
    },
  ] satisfies readonly (typeof FulfillmentSnapshotSchema.Encoded)[])(
    "refuses incomplete or inconsistent owner evidence",
    (input) =>
      Effect.gen(function* refusesEvidence() {
        const result = yield* Effect.result(project(input));
        expect(Result.isFailure(result)).toBe(true);
      }),
  );
  it.effect("keeps a genuine zero shipping charge and an empty offer separate", () =>
    Effect.gen(function* zeroAndEmpty() {
      const zero = yield* project({
        ...snapshot,
        checkout: {
          ...snapshot.checkout,
          shippingMethods: [{ id: "OSOBNI_ODBER", priceMinor: 0, title: "Pickup" }],
        },
      });
      expect(zero.shippingMethods[0]?.priceMinor).toBe(0);
      const empty = yield* project({
        ...snapshot,
        checkout: { ...snapshot.checkout, shippingMethods: [] },
      });
      expect(empty.shippingMethods).toHaveLength(0);
    }),
  );
  it.effect("renders actual delivery prices without fixture carriers or payment promises", () =>
    Effect.gen(function* actualPage() {
      const info = yield* project(snapshot);
      const html = renderToStaticMarkup(
        <FulfillmentView
          dictionary={getDictionary("cs")}
          kind="shipping"
          locale="cs"
          result={{ info, state: "ready" }}
        />,
      );
      expect(html).toContain("PPL – doručení na adresu");
      expect(html).toContain("129");
      expect(html).not.toContain("120");
      expect(html).not.toContain("Parcel Shop");
      expect(html).not.toContain("GoPay");
    }),
  );
  it.effect("reports unsupported payments without advertising a provider", () =>
    Effect.gen(function* noProvider() {
      const info = yield* project(snapshot);
      const d = getDictionary("en");
      const html = renderToStaticMarkup(
        <FulfillmentView
          dictionary={d}
          kind="payment"
          locale="en"
          result={{ info, state: "ready" }}
        />,
      );
      expect(html).toContain(d.fulfillment.noPayment);
      expect(html).toContain('href="/en/kontakty"');
      expect(html).not.toContain("GoPay");
    }),
  );
});
