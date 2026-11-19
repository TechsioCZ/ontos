// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutDraft } from "@/features/checkout/checkout-state";
import { createCheckoutDraft } from "@/features/checkout/checkout-state";
import { testMarket } from "../support/market-fixture";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const account = {
  id: "portal-customer-1",
  tenantId: "admitted-tenant",
  partyId: "admitted-party-1",
  email: "verified@example.test",
  name: "Customer",
};

let network: Awaited<ReturnType<typeof serveHttp>>;
let authenticated = true;
let unmarketed = false;
let customerOrders: object;
const compositionRevision = "a".repeat(64);
const gatewayBase = "/shell-super-app-api/order-route-test";
const actionPath = `${gatewayBase}/merchandise/actions/place-storefront-order`;
const actions = () =>
  network.requests.filter((request) => new URL(request.url).pathname === actionPath);
const actionPayload = async () => actions()[0].clone().json();
const ownerReads = async () =>
  Promise.all(
    network.requests
      .filter((request) => new URL(request.url).pathname.endsWith("/gateway-read"))
      .map((request) => request.clone().json()),
  );
const hasOwnerRead = async (query: object) => {
  expect(await ownerReads()).toContainEqual({
    audience: "merchandise",
    legalEntityId: "71000000-0000-4000-8000-000000000024",
    readName: "records",
    query,
  });
};

const routeRequest = async (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  if (authenticated) headers.set("cookie", "commerce-portal.session_token=admitted");
  const response = await fetch(`${network.origin}${path}`, { ...init, headers });
  // A completed real route response and a drained server precede every absence/count assertion.
  await network.idle();
  return response;
};

beforeEach(async () => {
  // Reset real isolate-local market/catalog caches; no module is replaced.
  vi.resetModules();
  authenticated = true;
  unmarketed = false;
  customerOrders = { orders: [], totalOrders: 0 };
  const { GET, POST } = await import("@/app/api/ontos/orders/route");
  network = await serveHttp(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/ontos/orders") {
      const context = nextRequest(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.method === "POST" ? { body: await request.text() } : {}),
      });
      try {
        return await context.run(() =>
          request.method === "POST" ? POST(context.request) : GET(context.request),
        );
      } finally {
        await context.close();
      }
    }
    const context = {
      apiBaseUrl: gatewayBase,
      compositionRevision,
      token: "order-route-test-assertion",
      expiresAt: Date.now() + 60_000,
    };
    if (path === "/shell-super-app-api/auth/api-key/gateway-context") {
      return Response.json(context);
    }
    if (path === `${gatewayBase}/api/portal-auth/customer-account`) {
      return Response.json(
        request.headers.get("cookie") === "commerce-portal.session_token=admitted"
          ? { state: "authenticated", account }
          : { state: "anonymous" },
      );
    }
    if (path === "/shell-super-app-api/auth/api-key/gateway-read") {
      const input = await request.json();
      const headers = { "x-ontos-gateway-context": JSON.stringify(context) };
      if (input.audience === "commerce-market-catalog") {
        const effectivePeriod = { startsAt: "2020-01-01T00:00:00.000Z" };
        const sellingLegalEntityRef = { resourceId: "71000000-0000-4000-8000-000000000024" };
        const entries = ["cs", "sk", "en"].map((locale) => ({
          marketRef: { resourceId: locale === "cs" ? testMarket.marketId : `market-${locale}` },
          marketCode: `AKROS-${locale.toUpperCase()}`,
          supportedLocales: [locale],
          lifecycle: "ACTIVE",
          effectivePeriod,
          sellingLegalEntityRef,
        }));
        return Response.json(
          {
            markets: unmarketed ? [] : entries,
            associations: unmarketed
              ? []
              : entries.map((entry) => ({
                  marketRef: entry.marketRef,
                  storefrontRef: { appId: "akros-storefront", tenantId: account.tenantId },
                  sellingLegalEntityRef,
                  channel: "B2C",
                  effectivePeriod,
                })),
          },
          { headers },
        );
      }
      if (input.audience === "merchandise" && input.readName === "records") {
        if (input.query.view.storefrontCustomerOrders)
          return Response.json(customerOrders, { headers });
        const marketId = input.query.view.storefrontCatalog?.marketId;
        return Response.json(
          {
            ...(marketId === undefined
              ? {}
              : {
                  market: { marketId, marketCode: "AKROS-CZ", currency: "CZK", configured: true },
                }),
            revision: 7,
            products: [],
            totalProducts: 0,
            checkout: {
              shippingMethods: [{ id: "PPL", title: "PPL", priceMinor: 12900 }],
              paymentAvailable: false,
              carrierTrackingAvailable: false,
            },
          },
          { headers },
        );
      }
    }
    if (path === actionPath) {
      return Response.json({
        storefrontOrder: {
          outcome: "PLACED",
          orderId: "order-1",
          orderNumber: "OBJ-2026-0022",
          totalMinor: 13425,
          totalVatMinor: 2330,
        },
      });
    }
    throw new Error(`Unexpected order-route HTTP request: ${request.method} ${path}`);
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "order-route-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", "akros-storefront");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000024");
});
afterEach(async () => {
  try {
    await network.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

const clientRequestId = "sf-12345678-1234-4234-8234-123456789abc";
const submit = async (
  company = "Company",
  deliveryId = "PPL",
  overrides: Partial<CheckoutDraft> = {},
) => {
  const draft = {
    ...createCheckoutDraft(),
    deliveryId,
    company,
    email: "forged@example.test",
    billing: {
      firstName: "Customer",
      lastName: "Test",
      street: "Test 1",
      city: "Brno",
      postalCode: "60200",
      country: "CZ",
      phone: "+420777123456",
    },
    ...overrides,
  };
  return routeRequest("/api/ontos/orders", {
    method: "POST",
    headers: {
      origin: network.origin,
      "x-akros-market-locale": "cs",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      customerAccountId: "attacker",
      clientRequestId,
      draft,
      cart: { version: 3, lines: [{ productId: "product-1", quantity: 5, priceMinor: 105 }] },
    }),
  });
};
describe("real order boundary", () => {
  it("places against fresh revision using admitted identity and owner shipping prices, not browser identity", async () => {
    expect((await submit()).status).toBe(200);
    const admission = network.requests.find((request) =>
      new URL(request.url).pathname.endsWith("/customer-account"),
    );
    expect(admission?.headers.get("origin")).toBe(network.origin);
    expect(admission?.headers.get("cookie")).toBe("commerce-portal.session_token=admitted");
    // The storefront key is admitted only on the narrow storefront-order Action, never on apply-command.
    expect(new URL(actions()[0].url).pathname).toBe(actionPath);
    expect(actions()).toHaveLength(1);
    const payload = await actionPayload();
    expect(payload).toMatchObject({
      expectedRevision: 7,
      command: {
        customerAccountId: account.id,
        partyId: account.partyId,
        contact: { email: account.email },
        clientRequestId,
        shippingMethod: "PPL",
        expectedShippingPriceMinor: 12900,
        note: "Company",
        // The market the server resolved for this request, never a browser-sent id.
        marketId: testMarket.marketId,
      },
    });
    // Shipping prices are read for the same market (converted into its currency by merchandise).
    await hasOwnerRead({
      view: {
        storefront: true,
        storefrontCheckout: true,
        storefrontCatalog: {
          marketId: testMarket.marketId,
          mode: "categories",
          includeCategories: false,
        },
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/DEMO|simulace|forged|attacker/);
  });
  it("places a plain CZK order without a market before any market exists", async () => {
    unmarketed = true;
    expect((await submit()).status).toBe(200);
    expect(await actionPayload()).toMatchObject({
      command: { _tag: "PlaceStorefrontOrder", expectedShippingPriceMinor: 12900 },
    });
    expect(await actionPayload()).not.toHaveProperty("command.marketId");
    await hasOwnerRead({ view: { storefront: true, storefrontCheckout: true } });
  });
  it.each([false, true])(
    "sends the selected delivery recipient separately from billing contact (different address: %s)",
    async (differentDeliveryAddress) => {
      const delivery = {
        city: "Praha",
        country: "CZ",
        firstName: "Jana",
        lastName: "Nováková",
        phone: "+420777987654",
        postalCode: "11000",
        street: "Delivery 2",
      };
      const response = await submit("Company", "PPL", { delivery, differentDeliveryAddress });
      expect(response.status).toBe(200);
      expect(await actionPayload()).toMatchObject({
        command: {
          contact: { email: account.email, name: "Customer Test", phone: "+420777123456" },
          billingAddress: { city: "Brno", country: "CZ", postalCode: "60200", street: "Test 1" },
          deliveryAddress: differentDeliveryAddress
            ? {
                city: delivery.city,
                country: delivery.country,
                postalCode: delivery.postalCode,
                street: delivery.street,
              }
            : { city: "Brno", country: "CZ", postalCode: "60200", street: "Test 1" },
          deliveryRecipient: differentDeliveryAddress
            ? { firstName: delivery.firstName, lastName: delivery.lastName, phone: delivery.phone }
            : { firstName: "Customer", lastName: "Test", phone: "+420777123456" },
        },
      });
    },
  );
  it.each(["firstName", "lastName", "phone"] as const)(
    "rejects invalid separate recipient %s before placing an order",
    async (field) => {
      const delivery = {
        city: "Praha",
        country: "CZ",
        firstName: "Jana",
        lastName: "Nováková",
        phone: "+420777987654",
        postalCode: "11000",
        street: "Delivery 2",
      };
      const response = await submit("Company", "PPL", {
        delivery: { ...delivery, [field]: "" },
        differentDeliveryAddress: true,
      });
      expect(response.status).toBe(400);
      expect(actions()).toHaveLength(0);
    },
  );
  it("places a guest order without a session: no customer account or Party, contact e-mail from the draft", async () => {
    authenticated = false;
    expect((await submit("", "PPL", { email: " guest@example.test " })).status).toBe(200);
    const payload = await actionPayload();
    expect(payload).toMatchObject({
      expectedRevision: 7,
      command: {
        _tag: "PlaceStorefrontOrder",
        clientRequestId,
        contact: { name: "Customer Test", email: "guest@example.test", phone: "+420777123456" },
        deliveryAddress: { city: "Brno", country: "CZ", postalCode: "60200", street: "Test 1" },
        shippingMethod: "PPL",
        expectedShippingPriceMinor: 12900,
      },
    });
    expect(payload.command).not.toHaveProperty("customerAccountId");
    expect(payload.command).not.toHaveProperty("partyId");
    expect(JSON.stringify(payload)).not.toMatch(/attacker/);
  });
  it("rejects a guest order without a valid contact e-mail", async () => {
    authenticated = false;
    expect((await submit("Company", "PPL", { email: "" })).status).toBe(400);
    expect(actions()).toHaveLength(0);
  });
  it("rejects a delivery method absent from the current owner configuration", async () => {
    expect((await submit("Company", "zasilkovna")).status).toBe(400);
    expect(actions()).toHaveLength(0);
  });
  it("retains customer note length limit without inserting a simulation disclaimer", async () => {
    expect((await submit("Ž".repeat(1200))).status).toBe(200);
    expect((await actionPayload()).command.note).toHaveLength(1000);
  });
  it("queries customer orders using only session subject, ignoring a forged query subject", async () => {
    customerOrders = { orders: [], totalOrders: 0 };
    const response = await routeRequest(
      "/api/ontos/orders?customerAccountId=attacker&order=other-order",
    );
    expect(response.status).toBe(200);
    await hasOwnerRead({
      view: {
        storefront: true,
        storefrontCustomerOrders: {
          customerAccountId: account.id,
          orderId: "other-order",
          offset: 0,
        },
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("fails closed if the owner returns another customer's receipt", async () => {
    customerOrders = {
      orders: [{ customerAccountId: "attacker" }],
      totalOrders: 1,
    };
    expect((await routeRequest("/api/ontos/orders")).status).toBe(503);
  });
});

describe("order messages follow the market language", () => {
  const postIn = (locale: string | undefined, body: object) =>
    routeRequest("/api/ontos/orders", {
      method: "POST",
      headers: {
        origin: network.origin,
        "content-type": "application/json",
        "x-akros-market-locale": locale ?? "cs",
      },
      body: JSON.stringify(body),
    });
  const cart = { version: 3, lines: [{ productId: "product-1", quantity: 5, priceMinor: 105 }] };
  it.each([
    [undefined, "Neplatné dodací údaje."],
    ["sk", "Neplatné dodacie údaje."],
    ["en", "Invalid delivery details."],
  ])("refuses invalid delivery details for locale %s", async (locale, message) => {
    const response = await postIn(locale, { cart, draft: {}, clientRequestId });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message });
    expect(actions()).toHaveLength(0);
  });
  it.each([
    [undefined, "Neplatná položka košíku."],
    ["sk", "Neplatná položka košíka."],
    ["en", "Invalid cart item."],
  ])("refuses an invalid cart line for locale %s", async (locale, message) => {
    const response = await postIn(locale, {
      cart: { version: 3, lines: [{ productId: "product-1", quantity: 0, priceMinor: 105 }] },
      draft: {},
      clientRequestId,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message });
  });
  it.each([
    [undefined, "Přihlaste se ke svému účtu."],
    ["en", "Sign in to your account."],
  ])("asks an anonymous visitor to sign in for locale %s", async (locale, message) => {
    authenticated = false;
    const response = await routeRequest("/api/ontos/orders", {
      headers: locale === undefined ? {} : { "x-akros-market-locale": locale },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message });
  });
});
