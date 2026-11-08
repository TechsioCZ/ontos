import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect, Fiber, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import type { OrderSchema } from "@app/merchandise/domain/merchandise-model";
import type { StorefrontConfiguration } from "../src/ontos/config";
import { CheckoutRequestSchema, CheckoutResultSchema } from "../src/ontos/checkout";
import type { CheckoutRequest } from "../src/ontos/checkout";
import { readCheckoutContext } from "../src/ontos/checkout-context";
import { portalRequestContext } from "../src/ontos/portal-server";
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
const customerAccount = {
  email: "customer@example.test",
  id: "71000000-0000-4000-8000-000000000091",
  name: "Native Customer",
  partyId: "71000000-0000-4000-8000-000000000092",
  tenantId: config.tenantId,
};
interface BackendOptions {
  readonly actionStatus?: number;
  readonly badPlacedProof?: boolean;
  readonly catalogBody?: unknown;
  readonly catalogStall?: boolean;
  readonly catalogStatus?: number;
  readonly countryCodes?: readonly string[];
  readonly existingOrder?: typeof OrderSchema.Encoded;
  readonly locale?: "cs" | "en";
  readonly noReceipt?: boolean;
  readonly portalAccount?: typeof customerAccount;
  readonly portalAnonymous?: boolean;
  readonly portalGatewayStatus?: number;
  readonly portalStatus?: number;
  readonly proposal?: boolean;
  readonly shippingPriceMinor?: number;
}
const readHeaders = {
  "x-ontos-gateway-context": JSON.stringify({
    apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
    compositionRevision: "a".repeat(64),
    expiresAt: 9_999_999_999,
    token: "redeemed-read-token",
  }),
};
const catalogResponse = (productIds: readonly string[], options: BackendOptions) => {
  if (options.catalogStall === true) {
    // An open transport response body exercises the optional read deadline without a new Effect root.
    return new Response(new ReadableStream(), { headers: readHeaders });
  }
  if (options.catalogStatus !== undefined) {
    return Response.json({}, { status: options.catalogStatus });
  }
  return Response.json(
    options.catalogBody ?? {
      market: { configured: true, currency: "CZK", marketId },
      products: productIds.map((id) => ({
        grossPriceMinor: 999_999,
        id,
        imageSrc: "media:a973f79c-0f97-476f-a003-f6db822156fb",
        name: "Renamed current product",
        slug: `${id}-current-slug`,
      })),
    },
    { headers: readHeaders },
  );
};
const savedLine = (index: number): (typeof OrderSchema.Encoded)["lines"][number] => ({
  productId: `product-${index + 1}`,
  productName: `Saved product ${index + 1}`,
  quantity: 2,
  sku: `SKU-${index + 1}`,
  unitPriceMinor: 1210,
  vatRate: 21,
});
const receiptOrders = (placed: boolean, options: BackendOptions) => {
  if (options.existingOrder !== undefined) {
    return [options.existingOrder];
  }
  return placed ? [order] : [];
};
const portalResponse = async (request: Request, options: BackendOptions) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/customer-account")) {
    return Response.json(
      options.portalAnonymous === true
        ? { state: "anonymous" }
        : { account: options.portalAccount ?? customerAccount, state: "authenticated" },
      { status: options.portalStatus ?? 200 },
    );
  }
  if (!path.endsWith("/gateway-context")) {
    return null;
  }
  const payload = await request.clone().json();
  if (payload.audience !== "commerce-customer-context") {
    return null;
  }
  if (options.portalGatewayStatus !== undefined) {
    return Response.json({}, { status: options.portalGatewayStatus });
  }
  return Response.json({
    apiBaseUrl: "/shell-super-app-api/gateway/portal",
    compositionRevision: "a".repeat(64),
    expiresAt: 9_999_999_999,
    token: "portal-test-only-assertion",
  });
};
const nonCommittedActionResponse = (options: BackendOptions) => {
  if (options.actionStatus !== undefined) {
    return Response.json({}, { status: options.actionStatus });
  }
  if (options.proposal === true) {
    return Response.json(
      {
        _tag: "ActionProposalAccepted",
        expiresAt: "2026-11-08T12:00:00.000Z",
        proposalId: "60000000-0000-4000-8000-000000000001",
      },
      { status: 202 },
    );
  }
  return null;
};
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
    const portal = await portalResponse(request, options);
    if (portal !== null) {
      return portal;
    }
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
      } else if (payload.query.view.storefrontCatalog?.productIds !== undefined) {
        return catalogResponse(payload.query.view.storefrontCatalog.productIds, options);
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
        body = { orders: receiptOrders(placed, options) };
      }
      return Response.json(body, { headers: readHeaders });
    }
    if (path.endsWith("/gateway-context")) {
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: "new-action-token",
      });
    }
    const stopped = nonCommittedActionResponse(options);
    if (stopped !== null) {
      return stopped;
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

const customerContext = () =>
  portalRequestContext(
    "https://n1.example",
    "commerce-portal.session=customer-test-session; staff.session=never-relay",
  );
const customerOrder = {
  ...order,
  customerAccountId: customerAccount.id,
  partyId: customerAccount.partyId,
};

describe("checkout derives customer ownership from fresh native Portal admission", () => {
  it.effect("maps a definite Portal gateway refusal to forbidden before any Action", () =>
    Effect.gen(function* refusedPortalGate() {
      const owner = backend({ portalGatewayStatus: 403 });
      const input = yield* decode();
      const result = yield* submitCheckoutWithConfiguration(config, input, customerContext()).pipe(
        Effect.result,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.state).toBe("forbidden");
      }
      expect(
        owner.calls.filter((call) => call.url.endsWith("/place-storefront-order")),
      ).toHaveLength(0);
    }),
  );
  for (const mode of ["quote", "place"] as const) {
    it.effect(`binds ${mode} to the admitted account and Party, never the contact email`, () =>
      Effect.gen(function* customerCheckout() {
        const owner = backend();
        const input = yield* decode({ ...draft, mode });
        const result = yield* submitCheckoutWithConfiguration(
          config,
          input,
          customerContext(),
        ).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        );
        expect(result.outcome).toBe(mode === "quote" ? "VALID" : "PLACED");
        const admission = owner.calls.filter((call) => call.url.endsWith("/customer-account"));
        expect(admission).toHaveLength(1);
        expect(admission[0]?.headers.get("cookie")).toContain("commerce-portal.session");
        expect(admission[0]?.headers.get("cookie")).not.toContain("staff.session");
        const actions = owner.calls.filter((call) => call.url.endsWith("/place-storefront-order"));
        expect(actions).toHaveLength(1);
        const payload = yield* Effect.promise(() => actions[0]?.json());
        expect(payload.command).toMatchObject({
          contact: { email: draft.contact.email },
          customerAccountId: customerAccount.id,
          dryRun: mode === "quote",
          partyId: customerAccount.partyId,
        });
        expect(JSON.stringify(result)).not.toContain(customerAccount.id);
        expect(JSON.stringify(result)).not.toContain(customerAccount.partyId);
      }),
    );
  }

  for (const options of [
    { portalAnonymous: true },
    { portalStatus: 403 },
    { portalStatus: 503 },
    { portalAccount: { ...customerAccount, tenantId: config.legalEntityId } },
  ] satisfies BackendOptions[]) {
    it.effect(
      `never silently places as guest when Portal cookies cannot admit: ${JSON.stringify(options)}`,
      () =>
        Effect.gen(function* noGuestDowngrade() {
          const owner = backend(options);
          const input = yield* decode();
          const outcome = yield* submitCheckoutWithConfiguration(
            config,
            input,
            customerContext(),
          ).pipe(
            Effect.result,
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
          );
          expect(Result.isFailure(outcome)).toBe(true);
          expect(
            owner.calls.filter((call) => call.url.endsWith("/place-storefront-order")),
          ).toHaveLength(0);
        }),
    );
  }

  it.effect("recovers the customer's canonical receipt without another Action", () =>
    Effect.gen(function* ownedReceipt() {
      const owner = backend({ existingOrder: customerOrder });
      const result = yield* recoverCheckoutWithConfiguration(
        config,
        { clientRequestId, locale: "cs", scope },
        customerContext(),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toMatchObject({
        result: { orderId: order.id, receipt: { contact: order.contact } },
        state: "confirmed",
      });
      expect(
        owner.calls.filter((call) => call.url.endsWith("/place-storefront-order")),
      ).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(customerAccount.id);
    }),
  );

  for (const portalAccount of [
    { ...customerAccount, id: "71000000-0000-4000-8000-000000000090" },
    { ...customerAccount, partyId: "71000000-0000-4000-8000-000000000090" },
  ]) {
    it.effect(
      `denies a customer receipt unless BOTH subject fields match: ${portalAccount.id}/${portalAccount.partyId}`,
      () =>
        Effect.gen(function* noForeignReceipt() {
          const owner = backend({ existingOrder: customerOrder, portalAccount });
          const result = yield* recoverCheckoutWithConfiguration(
            config,
            { clientRequestId, locale: "cs", scope },
            customerContext(),
          ).pipe(
            Effect.result,
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
          );
          expect(Result.isFailure(result)).toBe(true);
          expect(JSON.stringify(result)).not.toContain(order.contact.email);
          expect(
            owner.calls.filter((call) => call.url.endsWith("/place-storefront-order")),
          ).toHaveLength(0);
        }),
    );
  }

  it.effect("keeps a historical guest nonce guest after the browser later logs in", () =>
    Effect.gen(function* guestRemainsGuest() {
      const owner = backend({ existingOrder: order });
      const input = yield* decode();
      const result = yield* submitCheckoutWithConfiguration(config, input, customerContext()).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(result).toMatchObject({ orderId: order.id, outcome: "REPLAYED" });
      expect(
        owner.calls.filter((call) => call.url.endsWith("/place-storefront-order")),
      ).toHaveLength(0);
    }),
  );
  it.effect("reauthenticates placement instead of reusing the identity from a prior quote", () =>
    Effect.gen(function* freshPlacementIdentity() {
      const quotedOwner = backend();
      const quoted = yield* decode({ ...draft, mode: "quote" });
      yield* submitCheckoutWithConfiguration(config, quoted, customerContext()).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, quotedOwner.fetch),
      );
      const changedAccount = {
        ...customerAccount,
        id: "71000000-0000-4000-8000-000000000089",
        partyId: "71000000-0000-4000-8000-000000000088",
      };
      const placedOwner = backend({ portalAccount: changedAccount });
      const input = yield* decode();
      yield* submitCheckoutWithConfiguration(config, input, customerContext()).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, placedOwner.fetch),
      );
      const action = placedOwner.calls.find((call) => call.url.endsWith("/place-storefront-order"));
      expect(action).toBeDefined();
      if (action === undefined) {
        return;
      }
      const payload = yield* Effect.promise(() => action.json());
      expect(payload.command).toMatchObject({
        customerAccountId: changedAccount.id,
        partyId: changedAccount.partyId,
      });
    }),
  );
});

describe("owner-backed guest checkout", () => {
  for (const mode of ["quote", "place"] as const) {
    it.effect(`never treats a parked ${mode} proposal as a committed owner result`, () =>
      Effect.gen(function* parkedCheckout() {
        const owner = backend({ proposal: true });
        const input = yield* decode({ ...draft, mode });
        const result = yield* submitCheckoutWithConfiguration(config, input).pipe(
          Effect.result,
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.state).toBe("unavailable");
        }
        expect(
          owner.calls.filter((call) =>
            new URL(call.url).pathname.endsWith("/place-storefront-order"),
          ),
        ).toHaveLength(1);
      }),
    );
  }
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
          owner.calls.filter((call) =>
            new URL(call.url).pathname.endsWith("/place-storefront-order"),
          ),
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
        /\/place-storefront-order$/u,
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
      expect(owner.calls).toHaveLength(4);
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
      expect(result).toMatchObject({
        result: {
          lines: [{ name: "Triko", quantity: 2, unitPriceMinor: 1210 }],
          productPresentation: [
            {
              image: "/obrazky/product-1/a973f79c-0f97-476f-a003-f6db822156fb",
              productId: "product-1",
              slug: "product-1-current-slug",
            },
          ],
          totalMinor: 15_320,
          totalVatMinor: 2659,
        },
      });
      const catalog = yield* Effect.promise(() => owner.calls[3]?.json());
      expect(catalog).toMatchObject({
        audience: "merchandise",
        legalEntityId: config.legalEntityId,
        query: {
          view: {
            storefront: true,
            storefrontCatalog: {
              fields: "card",
              includeCategories: false,
              marketId,
              pageSize: 1,
              productIds: ["product-1"],
            },
          },
        },
        readName: "records",
      });
    }),
  );
  it.effect("enriches fifty exact products in three bounded card reads", () =>
    Effect.gen(function* boundedReceiptMedia() {
      const lines = Array.from({ length: 50 }).map((_, index) => savedLine(index));
      const owner = backend({ existingOrder: { ...order, lines } });
      const recovery = yield* recoverCheckoutWithConfiguration(config, {
        clientRequestId,
        locale: "cs",
        scope,
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(recovery.state).toBe("confirmed");
      if (recovery.state === "confirmed") {
        expect(recovery.result.productPresentation).toHaveLength(50);
        expect(recovery.result.lines.map((line) => line.name)).toEqual(
          lines.map((line) => line.productName),
        );
        expect(recovery.result.lines.every((line) => line.unitPriceMinor === 1210)).toBe(true);
        expect(recovery.result.totalMinor).toBe(15_320);
      }
      const reads = yield* Effect.all(
        owner.calls.map((call) => Effect.promise(() => call.json())),
        { concurrency: 1 },
      );
      const catalogs = reads.filter(
        (read) => read.query.view?.storefrontCatalog?.productIds !== undefined,
      );
      expect(catalogs.map((read) => read.query.view.storefrontCatalog.productIds.length)).toEqual([
        24, 24, 2,
      ]);
      expect(catalogs.map((read) => read.query.view.storefrontCatalog.pageSize)).toEqual([
        24, 24, 2,
      ]);
      expect(
        catalogs.every(
          (read) =>
            read.legalEntityId === config.legalEntityId &&
            read.query.view.storefrontCatalog.marketId === marketId &&
            read.query.view.storefrontCatalog.fields === "card",
        ),
      ).toBe(true);
      expect(catalogs.flatMap((read) => read.query.view.storefrontCatalog.productIds)).toEqual(
        lines.map((line) => line.productId),
      );
      expect(owner.calls).toHaveLength(6);
    }),
  );
  it.effect("deduplicates product reads while preserving separate saved variants", () =>
    Effect.gen(function* sharedProductMedia() {
      const lines = ["small", "large"].map(
        (variantId): (typeof OrderSchema.Encoded)["lines"][number] => ({
          productId: "product-1",
          productName: "Saved shirt",
          quantity: 2,
          sku: variantId,
          unitPriceMinor: 1210,
          variantId,
          variantName: `Saved ${variantId}`,
          vatRate: 21,
        }),
      );
      const owner = backend({ existingOrder: { ...order, lines } });
      const recovery = yield* recoverCheckoutWithConfiguration(config, {
        clientRequestId,
        locale: "cs",
        scope,
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
      );
      expect(recovery).toMatchObject({
        result: {
          lines: [{ variantName: "Saved small" }, { variantName: "Saved large" }],
          productPresentation: [{ productId: "product-1" }],
        },
        state: "confirmed",
      });
      const catalog = yield* Effect.promise(() => owner.calls[3]?.json());
      expect(catalog.query.view.storefrontCatalog.productIds).toEqual(["product-1"]);
      expect(owner.calls).toHaveLength(4);
    }),
  );
  const catalogProduct = { id: "product-1", name: "Current name", slug: "current-slug" };
  const catalogMarket = { configured: true, currency: "CZK", marketId };
  for (const catalogBody of [
    { market: { ...catalogMarket, configured: false }, products: [catalogProduct] },
    { market: { ...catalogMarket, currency: "EUR" }, products: [catalogProduct] },
    { market: { ...catalogMarket, marketId: "foreign-market" }, products: [catalogProduct] },
    { market: catalogMarket, products: [{ ...catalogProduct, id: "unrequested-product" }] },
    { market: catalogMarket, products: [catalogProduct, catalogProduct] },
    { market: catalogMarket, products: [{ id: "product-1" }] },
    { market: catalogMarket, products: [{ ...catalogProduct, slug: "" }] },
  ]) {
    it.effect(
      `keeps confirmed order when optional catalog data is invalid ${JSON.stringify(catalogBody)}`,
      () =>
        Effect.gen(function* optionalMediaCannotLoseOrder() {
          const owner = backend({ catalogBody, existingOrder: order });
          const recovery = yield* recoverCheckoutWithConfiguration(config, {
            clientRequestId,
            locale: "cs",
            scope,
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
          );
          expect(recovery).toMatchObject({
            result: {
              lines: [{ name: "Triko", quantity: 2, unitPriceMinor: 1210 }],
              orderId: "order-1",
              outcome: "REPLAYED",
              totalMinor: 15_320,
              totalVatMinor: 2659,
            },
            state: "confirmed",
          });
          if (recovery.state === "confirmed") {
            expect(recovery.result).not.toHaveProperty("productPresentation");
          }
          expect(owner.calls).toHaveLength(4);
        }),
    );
  }
  it.effect(
    "keeps confirmation after optional media denial and skips more than fifty product IDs",
    () =>
      Effect.gen(function* optionalMediaBounds() {
        const scenarios: readonly BackendOptions[] = [
          { catalogStatus: 403, existingOrder: order },
          {
            existingOrder: {
              ...order,
              lines: Array.from({ length: 51 }).map((_, index) => savedLine(index)),
            },
          },
        ];
        for (const options of scenarios) {
          const owner = backend(options);
          const recovery = yield* recoverCheckoutWithConfiguration(config, {
            clientRequestId,
            locale: "cs",
            scope,
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
          );
          expect(recovery.state).toBe("confirmed");
          if (recovery.state === "confirmed") {
            expect(recovery.result).not.toHaveProperty("productPresentation");
          }
          expect(owner.calls).toHaveLength(options.catalogStatus === 403 ? 4 : 3);
        }
      }),
  );
  it.effect("times out only optional receipt media while keeping the confirmed order", () =>
    Effect.gen(function* optionalMediaDeadline() {
      const owner = backend({ catalogStall: true, existingOrder: order });
      const fiber = yield* Effect.forkChild(
        recoverCheckoutWithConfiguration(config, { clientRequestId, locale: "cs", scope }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        ),
      );
      yield* TestClock.adjust("3 seconds");
      const recovery = yield* Fiber.join(fiber);
      expect(recovery).toMatchObject({
        result: { orderId: "order-1", outcome: "REPLAYED", totalMinor: 15_320 },
        state: "confirmed",
      });
      if (recovery.state === "confirmed") {
        expect(recovery.result).not.toHaveProperty("productPresentation");
      }
      expect(owner.calls).toHaveLength(4);
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
