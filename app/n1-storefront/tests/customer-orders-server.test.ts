import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";
import type { OrderSchema } from "@app/merchandise/contracts/records";
import type { StorefrontConfiguration } from "../src/ontos/config";
import { readCustomerOrdersWithConfiguration } from "../src/ontos/customer-orders-server";
import { portalRequestContext } from "../src/ontos/portal-server";

const config = {
  apiKey: "customer-orders-test-only-key",
  appId: "n1-storefront",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  shellUrl: "https://shell.example",
  tenantId: "71000000-0000-4000-8000-000000000098",
} satisfies StorefrontConfiguration;
const account = {
  email: "private@example.test",
  id: "71000000-0000-4000-8000-000000000096",
  name: "Jan Novák",
  partyId: "71000000-0000-4000-8000-000000000095",
  tenantId: config.tenantId,
};
const order = {
  billingAddress: { city: "Praha", country: "CZ", postalCode: "11000", street: "Soukromá 1" },
  channel: "STOREFRONT",
  clientRequestId: "71000000-0000-4000-8000-000000000094",
  contact: { email: account.email, name: account.name },
  createdAt: "2026-11-04T12:00:00.000Z",
  customerAccountId: account.id,
  deliveryAddress: { city: "Praha", country: "CZ", postalCode: "11000", street: "Soukromá 2" },
  id: "order-1",
  lines: [
    {
      productId: "product-1",
      productName: "Triko",
      quantity: 2,
      sku: "SKU-1",
      unitPriceMinor: 1000,
      vatRate: 21,
    },
  ],
  market: {
    currency: "EUR",
    exchangeRate: "0.04",
    marketCode: "N1-EU",
    marketId: "71000000-0000-4000-8000-000000000093",
    roundingMinor: 1,
  },
  number: "N1-42",
  partyId: account.partyId,
  pricesIncludeVat: true,
  shipping: { label: "PPL", method: "PPL", priceMinor: 500, vatRate: 21 },
  status: "NEW",
  totalMinor: 2500,
  totalVatMinor: 434,
  updatedAt: "2026-11-04T12:00:00.000Z",
} satisfies typeof OrderSchema.Encoded;
interface BackendOptions {
  anonymous?: boolean;
  foreignTenant?: boolean;
  gatewayStatus?: number;
  invalidCurrency?: boolean;
  orders?: readonly (typeof OrderSchema.Encoded)[];
  products?: readonly unknown[];
  recordsStatus?: number;
  total?: number;
}
const backend = (options: BackendOptions = {}) => {
  const calls: Request[] = [];
  let recordReads = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path.endsWith("/gateway-context")) {
      if (options.gatewayStatus !== undefined) {
        return Response.json({}, { status: options.gatewayStatus });
      }
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/gateway/portal",
        compositionRevision: "a".repeat(64),
        expiresAt: 1_000_000,
        token: "portal-test-only-assertion",
      });
    }
    if (path.endsWith("/customer-account")) {
      return Response.json(
        options.anonymous === true
          ? { state: "anonymous" }
          : {
              account:
                options.foreignTenant === true
                  ? { ...account, tenantId: "71000000-0000-4000-8000-000000000097" }
                  : account,
              state: "authenticated",
            },
      );
    }
    if (path.endsWith("/gateway-read")) {
      recordReads += 1;
      if (options.recordsStatus !== undefined) {
        return Response.json({}, { status: options.recordsStatus });
      }
      const orders = options.orders ?? [order];
      const wireOrders =
        options.invalidCurrency === true
          ? orders.map((value) => ({
              ...value,
              market: {
                currency: "USD",
                exchangeRate: "1",
                marketCode: "invalid",
                marketId: "71000000-0000-4000-8000-000000000093",
                roundingMinor: 1,
              },
            }))
          : orders;
      return Response.json(
        {
          movements: [],
          orders: wireOrders,
          products: options.products ?? [],
          totalOrders: options.total ?? orders.length,
        },
        {
          headers: {
            "x-ontos-gateway-context": JSON.stringify({
              apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
              compositionRevision: "a".repeat(64),
              expiresAt: 1_000_000,
              token: "used-test-only-assertion",
            }),
          },
        },
      );
    }
    return Response.json({}, { status: 503 });
  };
  return { calls, fetch, reads: () => recordReads };
};
const context = () =>
  portalRequestContext(
    "https://n1.example",
    "commerce-portal.session=customer-session; staff.session=never-relay",
  );
const provided = <A, E>(
  program: Effect.Effect<A, E, HttpClient.HttpClient>,
  owner: ReturnType<typeof backend>,
) =>
  program.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
  );

describe("fresh authenticated own-order read", () => {
  it.effect(
    "derives the subject from native admission and returns compact list data in stored currency",
    () =>
      Effect.gen(function* ownList() {
        const owner = backend();
        const result = yield* provided(
          readCustomerOrdersWithConfiguration(config, { locale: "cs" }, context()),
          owner,
        );
        expect(result.orders[0]?.currency).toBe("EUR");
        expect(result.orders[0]?.updatedAt).toBe(order.updatedAt);
        expect(result.orders[0]?.totalMinor).toBe(2500);
        expect(result.orders[0]?.detail).toBeNull();
        expect(result.orders[0]?.preview).toEqual([
          {
            name: "Triko",
            productId: "product-1",
            quantity: 2,
            sku: "SKU-1",
            variantId: null,
            variantName: null,
          },
        ]);
        const query = yield* Effect.promise(async () => await owner.calls[2]?.json());
        expect(query).toEqual({
          audience: "merchandise",
          legalEntityId: config.legalEntityId,
          query: {
            view: {
              storefront: true,
              storefrontCustomerOrders: { customerAccountId: account.id, offset: 0 },
            },
          },
          readName: "records",
        });
        expect(owner.calls[1]?.headers.get("cookie")).toContain("commerce-portal.session");
        expect(owner.calls[1]?.headers.get("cookie")).not.toContain("staff.session");
        const body = JSON.stringify(result);
        for (const privateField of [
          account.id,
          account.partyId,
          account.email,
          "Soukromá",
          "clientRequestId",
          "actorPrincipalRef",
        ]) {
          expect(body).not.toContain(privateField);
        }
      }),
  );
  it.effect("returns stored contact and addresses only for an owned requested detail", () =>
    Effect.gen(function* ownDetail() {
      const owner = backend();
      const result = yield* provided(
        readCustomerOrdersWithConfiguration(config, { locale: "en", orderId: order.id }, context()),
        owner,
      );
      expect(result.orders[0]?.detail?.contact).toEqual(order.contact);
      expect(result.orders[0]?.detail?.deliveryAddress).toEqual(order.deliveryAddress);
      expect(result.orders[0]?.detail?.lines).toEqual(order.lines);
      expect(result.orders[0]?.currency).toBe("EUR");
      expect(JSON.stringify(result)).not.toContain("customerAccountId");
      expect(JSON.stringify(result)).not.toContain("partyId");
    }),
  );
  it.effect("performs no merchandise read for anonymous or foreign-tenant admission", () =>
    Effect.gen(function* identityBeforeOrders() {
      for (const options of [{ anonymous: true }, { foreignTenant: true }]) {
        const owner = backend(options);
        const failure = yield* Effect.flip(
          provided(readCustomerOrdersWithConfiguration(config, { locale: "cs" }, context()), owner),
        );
        expect(failure.state).toBe(options.anonymous === true ? "anonymous" : "unavailable");
        expect(owner.reads()).toBe(0);
      }
    }),
  );
  it.effect("does not substitute staff reads after a denied owner request", () =>
    Effect.gen(function* noStaffFallback() {
      const owner = backend({ recordsStatus: 403 });
      const failure = yield* Effect.flip(
        provided(readCustomerOrdersWithConfiguration(config, { locale: "cs" }, context()), owner),
      );
      expect(failure.state).toBe("forbidden");
      expect(owner.reads()).toBe(1);
    }),
  );
  it.effect("does not query merchandise after an admission gateway refusal", () =>
    Effect.gen(function* refusedAdmission() {
      const owner = backend({ gatewayStatus: 403 });
      const failure = yield* Effect.flip(
        provided(readCustomerOrdersWithConfiguration(config, { locale: "cs" }, context()), owner),
      );
      expect(failure.state).toBe("forbidden");
      expect(owner.reads()).toBe(0);
    }),
  );
  it.effect(
    "rejects foreign customers, staff channels, wrong details and unrelated product records",
    () =>
      Effect.gen(function* rejectOwnerScopeViolation() {
        for (const options of [
          { orders: [{ ...order, customerAccountId: "other-customer" }] },
          { orders: [{ ...order, channel: "STAFF" }] },
          { orders: [{ ...order, id: "other-order" }] },
          { orders: [order], products: [{}] },
        ] satisfies BackendOptions[]) {
          const owner = backend(options);
          const failure = yield* Effect.flip(
            provided(
              readCustomerOrdersWithConfiguration(
                config,
                { locale: "cs", orderId: order.id },
                context(),
              ),
              owner,
            ),
          );
          expect(failure.state).toBe("unavailable");
        }
      }),
  );
  it.effect("does not convert guest orders by matching contact email", () =>
    Effect.gen(function* noGuestConversion() {
      const { customerAccountId: _subject, ...guestOrder } = order;
      const owner = backend({ orders: [guestOrder] });
      const failure = yield* Effect.flip(
        provided(readCustomerOrdersWithConfiguration(config, { locale: "cs" }, context()), owner),
      );
      expect(failure.state).toBe("unavailable");
    }),
  );
  it.effect("uses native legacy CZK without fabricating the stored VAT price mode", () =>
    Effect.gen(function* legacyOwnerCurrency() {
      const { market: _market, pricesIncludeVat: _mode, ...legacyOrder } = order;
      const owner = backend({ orders: [legacyOrder] });
      const result = yield* provided(
        readCustomerOrdersWithConfiguration(config, { locale: "en" }, context()),
        owner,
      );
      expect(result.orders[0]?.currency).toBe("CZK");
      expect(result.orders[0]?.market).toBeNull();
      expect(result.orders[0]?.pricesIncludeVat).toBeNull();
    }),
  );
  it.effect("does not invent support for a currency outside the native order contract", () =>
    Effect.gen(function* unsupportedStoredCurrency() {
      const owner = backend({ invalidCurrency: true });
      const failure = yield* Effect.flip(
        provided(readCustomerOrdersWithConfiguration(config, { locale: "en" }, context()), owner),
      );
      expect(failure.state).toBe("unavailable");
    }),
  );
  it.effect("keeps pagination and empty detail results honest", () =>
    Effect.gen(function* emptyPages() {
      const owner = backend({ orders: [], total: 50 });
      const page = yield* provided(
        readCustomerOrdersWithConfiguration(config, { locale: "cs", offset: 50 }, context()),
        owner,
      );
      expect(page).toEqual({ offset: 50, orders: [], pageSize: 50, total: 50 });
      const detailOwner = backend({ orders: [], total: 0 });
      const detail = yield* provided(
        readCustomerOrdersWithConfiguration(
          config,
          { locale: "cs", orderId: "missing" },
          context(),
        ),
        detailOwner,
      );
      expect(detail.orders).toEqual([]);
      expect(detail.total).toBe(0);
    }),
  );
});
