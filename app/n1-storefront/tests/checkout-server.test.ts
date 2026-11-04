import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import type { OrderSchema } from "@app/merchandise/domain/merchandise-model";
import type { StorefrontConfiguration } from "../src/ontos/config";
import { CheckoutRequestSchema, CheckoutResultSchema } from "../src/ontos/checkout";
import type { CheckoutRequest } from "../src/ontos/checkout";
import { readCheckoutContext } from "../src/ontos/checkout-context";
import {
  recoverCheckoutWithConfiguration,
  submitCheckoutWithConfiguration,
} from "../src/ontos/checkout-server";

const config = {
  apiKey: "checkout-test-only-key",
  appId: "n1-storefront",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  shellUrl: "https://shell.example",
  tenantId: "71000000-0000-4000-8000-000000000098",
} satisfies StorefrontConfiguration;
const marketId = "71000000-0000-4000-8000-000000000097";
const scope = {
  currency: "CZK",
  legalEntityId: config.legalEntityId,
  marketId,
  tenantId: config.tenantId,
} satisfies CheckoutRequest["scope"];
const clientRequestId = "71000000-0000-4000-8000-000000000096";
const draft = {
  address: { city: "Praha", country: "CZ", postalCode: "110 00", street: "Testovací 1" },
  clientRequestId,
  contact: { email: "buyer@example.test", firstName: "Jan", lastName: "Novák" },
  expectedShippingPriceMinor: 12_900,
  lines: [{ expectedUnitPriceMinor: 1210, productId: "product-1", quantity: 2 }],
  locale: "cs",
  mode: "place",
  scope,
  shippingMethod: "PPL",
} satisfies typeof CheckoutRequestSchema.Encoded;
const order = {
  billingAddress: draft.address,
  channel: "STOREFRONT",
  clientRequestId,
  contact: { email: "saved@example.test", name: "Uložený příjemce" },
  createdAt: "2026-11-04T12:00:00.000Z",
  deliveryAddress: { ...draft.address, street: "Uložená 2" },
  id: "order-1",
  lines: [
    {
      productId: "product-1",
      productName: "Triko",
      quantity: 2,
      sku: "SKU-1",
      unitPriceMinor: 1210,
      vatRate: 21,
    },
  ],
  market: { currency: "CZK", exchangeRate: "1", marketCode: "N1-CZ", marketId, roundingMinor: 1 },
  number: "N1-42",
  partyId: "guest-party",
  pricesIncludeVat: true,
  shipping: { label: "PPL", method: "PPL", priceMinor: 12_900, vatRate: 21 },
  status: "NEW",
  totalMinor: 15_320,
  totalVatMinor: 2659,
  updatedAt: "2026-11-04T12:00:00.000Z",
} satisfies typeof OrderSchema.Encoded;
interface BackendOptions {
  readonly actionStatus?: number;
  readonly badPlacedProof?: boolean;
  readonly countryCodes?: readonly string[];
  readonly existingOrder?: typeof order;
  readonly locale?: "cs" | "en";
  readonly noReceipt?: boolean;
  readonly shippingPriceMinor?: number;
}
const backend = (options: BackendOptions = {}) => {
  const calls: Request[] = [];
  const countryCodes = options.countryCodes ?? ["CZ"];
  const shippingPriceMinor = options.shippingPriceMinor ?? 12_900;
  const supportedLocale = options.locale === "en" ? "en-GB" : "cs-CZ";
  let placed = false;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request.clone());
    const path = new URL(request.url).pathname;
    const payload = await request.clone().json();
    if (path.endsWith("/gateway-read")) {
      let body;
      if (payload.audience === "commerce-market-catalog") {
        const period = { startsAt: "1970-01-01T00:00:00.000Z" };
        body = {
          associations: [
            {
              channel: "B2C",
              effectivePeriod: period,
              marketRef: { resourceId: marketId },
              sellingLegalEntityRef: { resourceId: config.legalEntityId },
              storefrontRef: { appId: config.appId, tenantId: config.tenantId },
            },
          ],
          markets: [
            {
              effectivePeriod: period,
              jurisdictions: countryCodes.map((code) => ({
                code,
                kind: "COUNTRY",
              })),
              lifecycle: "ACTIVE",
              marketCode: "N1-CZ",
              marketRef: { resourceId: marketId },
              sellingLegalEntityRef: { resourceId: config.legalEntityId },
              supportedLocales: [supportedLocale],
            },
          ],
        };
      } else if (payload.query.view.orderClientRequestId === undefined) {
        body = {
          checkout: {
            carrierTrackingAvailable: false,
            paymentAvailable: false,
            shippingMethods: [{ id: "PPL", priceMinor: shippingPriceMinor, title: "PPL" }],
          },
          market: { configured: true, currency: "CZK", marketId },
          revision: 7,
        };
      } else {
        if (placed && options.noReceipt === true) {
          return Response.json({}, { status: 503 });
        }
        const orders = [];
        if (options.existingOrder === undefined) {
          if (placed) {
            orders.push(order);
          }
        } else {
          orders.push(options.existingOrder);
        }
        body = { orders };
      }
      return Response.json(body, {
        headers: {
          "x-ontos-gateway-context": JSON.stringify({
            apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
            compositionRevision: "a".repeat(64),
            expiresAt: 9_999_999_999,
            token: "redeemed-read-token",
          }),
        },
      });
    }
    if (path.endsWith("/gateway-context")) {
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: "new-action-token",
      });
    }
    if (options.actionStatus !== undefined) {
      return Response.json({}, { status: options.actionStatus });
    }
    placed = payload.command.dryRun === false;
    return Response.json({
      entityIds: placed ? ["order-1"] : [],
      revision: placed ? 8 : 7,
      storefrontOrder: {
        issues: [],
        lines: [
          {
            lineTotalMinor: 2420,
            name: "Triko",
            productId: "product-1",
            quantity: 2,
            sku: "SKU-1",
            unitPriceMinor: 1210,
          },
        ],
        market: { configured: true, currency: "CZK", marketId },
        orderId: placed && options.badPlacedProof !== true ? "order-1" : undefined,
        orderNumber: placed && options.badPlacedProof !== true ? "N1-42" : undefined,
        outcome: placed ? "PLACED" : "VALID",
        shippingPriceMinor: 12_900,
        status: placed && options.badPlacedProof !== true ? "NEW" : undefined,
        totalMinor: 15_320,
        totalVatMinor: 2659,
      },
    });
  };
  return { calls, fetch };
};
const decode = (input: typeof CheckoutRequestSchema.Encoded = draft) =>
  Schema.decodeUnknownEffect(CheckoutRequestSchema, { onExcessProperty: "error" })(input);

describe("owner-backed guest checkout", () => {
  it("preserves shipping-inclusive VAT and refuses shipping above the grand total", () => {
    // Native fullOrderTotals includes shipping VAT: goods2420/420VAT + shipping12900/2239VAT.
    const shippingHeavy = {
      issues: [],
      lines: [
        {
          lineTotalMinor: 2420,
          name: "Triko",
          productId: "product-1",
          quantity: 2,
          sku: "SKU-1",
          unitPriceMinor: 1210,
        },
      ],
      orderId: null,
      orderNumber: null,
      outcome: "VALID",
      scope,
      shippingPriceMinor: 12_900,
      status: null,
      totalMinor: 15_320,
      totalVatMinor: 2659,
    };
    expect(Schema.is(CheckoutResultSchema)(shippingHeavy)).toBe(true);
    expect(shippingHeavy.shippingPriceMinor + shippingHeavy.totalVatMinor).toBeGreaterThan(
      shippingHeavy.totalMinor,
    );
    expect(Schema.is(CheckoutResultSchema)({ ...shippingHeavy, shippingPriceMinor: 15_321 })).toBe(
      false,
    );
  });
  it.effect("uses explicit COUNTRY jurisdiction rather than the UI language", () =>
    Effect.gen(function* ownerCountry() {
      const owner = backend({ locale: "en" });
      const context = yield* readCheckoutContext(config, "en").pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(context.countryCodes).toEqual(["CZ"]);
      expect(context.paymentAvailable).toBe(false);
      expect(context.shippingMethods.map((method) => method.id)).toEqual(["PPL"]);
      const records = yield* Effect.promise(() => owner.calls[1]?.json());
      expect(records.query.view).toEqual({
        storefront: true,
        storefrontCatalog: { includeCategories: false, marketId, mode: "categories" },
        storefrontCheckout: true,
      });
    }),
  );
  it.effect("refuses a foreign tenant before any network call", () =>
    Effect.gen(function* noForeignScope() {
      const owner = backend();
      const input = yield* decode({
        ...draft,
        scope: { ...scope, tenantId: config.legalEntityId },
      });
      const result = yield* submitCheckoutWithConfiguration(config, input).pipe(
        Effect.result,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.state).toBe("scope-mismatch");
      }
      expect(owner.calls).toHaveLength(0);
    }),
  );
  for (const changes of [
    { shippingMethod: "ZASILKOVNA" } satisfies Pick<CheckoutRequest, "shippingMethod">,
    { expectedShippingPriceMinor: 0 },
  ]) {
    it.effect(`does not send unsupported or stale shipping ${JSON.stringify(changes)}`, () =>
      Effect.gen(function* rejectShipping() {
        const owner = backend();
        const input = yield* decode({ ...draft, ...changes });
        const result = yield* submitCheckoutWithConfiguration(config, input).pipe(
          Effect.result,
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.state).toBe("invalid");
        }
        expect(
          owner.calls.every((call) => new URL(call.url).pathname.endsWith("/gateway-read")),
        ).toBe(true);
      }),
    );
  }
  it.effect("quotes shipping-inclusive owner amounts without placing an order", () =>
    Effect.gen(function* nativeQuote() {
      const owner = backend();
      const input = yield* decode({ ...draft, mode: "quote" });
      const result = yield* submitCheckoutWithConfiguration(config, input).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toMatchObject({
        orderId: null,
        outcome: "VALID",
        shippingPriceMinor: 12_900,
        totalMinor: 15_320,
        totalVatMinor: 2659,
      });
      const action = owner.calls.at(-1);
      expect(action?.headers.get("authorization")).toBe("Bearer new-action-token");
      expect(action?.headers.get("x-api-key")).toBeNull();
      const payload = yield* Effect.promise(async () => await action?.json());
      expect(payload).toMatchObject({
        command: {
          dryRun: true,
          expectedShippingPriceMinor: 12_900,
          marketId,
          shippingMethod: "PPL",
        },
        expectedRevision: 7,
      });
      expect(payload.command.clientRequestId).not.toBe(clientRequestId);
    }),
  );
  it.effect("places once with a stable native key and preserves only supported guest data", () =>
    Effect.gen(function* nativePlacement() {
      const owner = backend();
      const input = yield* decode();
      const result = yield* submitCheckoutWithConfiguration(config, input).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toMatchObject({
        orderId: "order-1",
        outcome: "PLACED",
        receipt: null,
      });
      const actions = owner.calls.filter(
        (call) =>
          !new URL(call.url).pathname.endsWith("/gateway-read") &&
          !new URL(call.url).pathname.endsWith("/gateway-context"),
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]?.headers.get("idempotency-key")).toBe(
        `n1-checkout-place-${clientRequestId}`,
      );
      const payload = yield* Effect.promise(() => actions[0]?.json());
      expect(payload.expectedRevision).toBe(0);
      expect(payload.command).toMatchObject({
        billingAddress: draft.address,
        clientRequestId,
        contact: { email: draft.contact.email, name: "Jan Novák" },
        deliveryAddress: draft.address,
        dryRun: false,
      });
      expect(payload.command.customerAccountId).toBeUndefined();
      expect(payload.command.partyId).toBeUndefined();
      expect(payload.command.deliveryRecipient).toBeUndefined();
    }),
  );
  for (const options of [{ actionStatus: 503 }, { badPlacedProof: true }]) {
    it.effect(`keeps an uncertain placement after ${JSON.stringify(options)}`, () =>
      Effect.gen(function* uncertainPlacement() {
        const owner = backend(options);
        const input = yield* decode();
        const result = yield* submitCheckoutWithConfiguration(config, input).pipe(
          Effect.result,
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.state).toBe("uncertain");
        }
        expect(
          owner.calls.filter((call) => new URL(call.url).pathname.endsWith("/apply-command")),
        ).toHaveLength(1);
      }),
    );
  }
  it.effect("returns native commit evidence without another HTTP request", () =>
    Effect.gen(function* placedWithoutReceiptDelay() {
      const owner = backend({ noReceipt: true });
      const input = yield* decode();
      const result = yield* submitCheckoutWithConfiguration(config, input).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toMatchObject({ orderId: "order-1", outcome: "PLACED", receipt: null });
      expect(owner.calls).toHaveLength(5);
      expect(new URL(owner.calls.at(-1)?.url ?? "https://unexpected.example").pathname).toMatch(
        /\/apply-command$/u,
      );
    }),
  );
  it.effect("recovers the canonical guest receipt without another Action", () =>
    Effect.gen(function* readonlyRecovery() {
      const owner = backend({ existingOrder: order });
      const result = yield* recoverCheckoutWithConfiguration(config, {
        clientRequestId,
        locale: "cs",
        scope: draft.scope,
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toMatchObject({
        result: {
          lines: [{ lineTotalMinor: null }],
          outcome: "REPLAYED",
          receipt: { contact: { email: "saved@example.test" } },
          totalMinor: 15_320,
        },
        state: "confirmed",
      });
      expect(owner.calls).toHaveLength(3);
      expect(
        owner.calls.every((call) => new URL(call.url).pathname.endsWith("/gateway-read")),
      ).toBe(true);
      const lookup = yield* Effect.promise(() => owner.calls[2]?.json());
      expect(lookup.query.view).toEqual({
        includeCategories: false,
        limit: 0,
        orderClientRequestId: clientRequestId,
        ordersLimit: 1,
        storefront: true,
      });
      expect(JSON.stringify(result)).not.toContain("customerAccountId");
      expect(JSON.stringify(result)).not.toContain("partyId");
    }),
  );
  for (const foreign of [
    { ...order, clientRequestId: "different-nonce" },
    { ...order, market: { ...order.market, marketId: "71000000-0000-4000-8000-000000000095" } },
  ]) {
    it.effect(
      `rejects a foreign recovery record ${foreign.clientRequestId}/${foreign.market.marketId}`,
      () =>
        Effect.gen(function* protectRecovery() {
          const owner = backend({ existingOrder: foreign });
          const result = yield* recoverCheckoutWithConfiguration(config, {
            clientRequestId,
            locale: "cs",
            scope: draft.scope,
          }).pipe(
            Effect.result,
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.state).toBe("unavailable");
          }
        }),
    );
  }
  it.effect("does not treat a missing receipt as permission to submit a new order", () =>
    Effect.gen(function* notFoundIsUnconfirmed() {
      const owner = backend();
      const result = yield* recoverCheckoutWithConfiguration(config, {
        clientRequestId,
        locale: "cs",
        scope: draft.scope,
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toEqual({ state: "unconfirmed" });
      expect(owner.calls).toHaveLength(3);
    }),
  );
});
