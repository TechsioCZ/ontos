// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/account/reorder/route";
import { createEmptyCart } from "@/features/cart/cart-state";
import { parseReorderResolution, prepareReorder } from "@/features/account/reorder";
import { cs } from "@/i18n/cs";
import { en } from "@/i18n/en";
import { projectProducts as project } from "@/ontos/catalog-projection";
import { MARKET_LOCALE_HEADER } from "@/ontos/market-locale";
import type { CustomerOrder } from "@/ontos/order-model";
import { resolveReorder } from "@/ontos/reorder";

import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const variantRecord = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  sku: `SKU-${id}`,
  name: `M 6 × ${id}`,
  active: true,
  priceMinor: 100,
  grossPriceMinor: 121,
  stockOnHand: 1000,
  availability: "IN_STOCK",
  minimumQuantity: 10,
  priceTiers: [
    { minimumQuantity: 1, priceMinor: 121, priceExcludingVatMinor: 100 },
    { minimumQuantity: 100, priceMinor: 115, priceExcludingVatMinor: 95 },
  ],
  ...overrides,
});
const catalogRecords = (...variants: ReturnType<typeof variantRecord>[]) => ({
  revision: 1,
  products: [
    {
      id: "p",
      slug: "srouby",
      name: "Šrouby",
      active: true,
      vatRate: 21,
      availability: "IN_STOCK",
      variantSummary: { count: 3, minGrossPriceMinor: 121, stockOnHand: 3000, units: ["ks"] },
      variantRecords: variants,
    },
  ],
});
const catalog = (...variants: ReturnType<typeof variantRecord>[]) =>
  project(catalogRecords(...variants));
const orderLine = (variantId: string, quantity: number): CustomerOrder["lines"][number] => ({
  productId: "p",
  productName: "Šrouby",
  sku: `SKU-${variantId}`,
  quantity,
  // Saved receipt price: never reused for the new cart.
  unitPriceMinor: 99,
  vatRate: 21,
  variantId,
  variantName: `M 6 × ${variantId}`,
});

describe("repeat order resolution", () => {
  it("resolves the exact ordered variants at current OntOS prices and tiers", () => {
    const { items, skipped } = resolveReorder(
      { lines: [orderLine("a", 20), orderLine("b", 200)] },
      catalog(variantRecord("a"), variantRecord("b")),
    );
    expect(skipped).toEqual([]);
    expect(items.map((item) => [item.variantId, item.quantity, item.priceMinor])).toEqual([
      ["a", 20, 121],
      ["b", 200, 115],
    ]);
    expect(items[0]).toMatchObject({
      productId: "p",
      slug: "srouby",
      name: "Šrouby",
      sku: "SKU-a",
      unit: "ks",
      minimumQuantity: 10,
      stockCount: 1000,
      priceExcludingVatMinor: 100,
    });
  });

  it("skips variants no longer offered, without a price or with unknown availability", () => {
    const { items, skipped } = resolveReorder(
      { lines: [orderLine("gone", 10), orderLine("free", 10), orderLine("unknown", 10)] },
      catalog(
        variantRecord("free", { priceMinor: 0, grossPriceMinor: 0, priceTiers: [] }),
        variantRecord("unknown", { availability: "UNKNOWN" }),
      ),
    );
    expect(items).toEqual([]);
    expect(skipped).toEqual([
      { sku: "SKU-gone", reason: "not-offered" },
      { sku: "SKU-free", reason: "price-unavailable" },
      { sku: "SKU-unknown", reason: "availability-unknown" },
    ]);
  });

  it("words skipped lines and stock limits from the market dictionary", () => {
    const resolution = resolveReorder(
      { lines: [orderLine("a", 2000), orderLine("gone", 10)] },
      catalog(variantRecord("a")),
    );
    const prepared = prepareReorder(createEmptyCart(), resolution, cs);
    expect(prepared.result.addedLines).toBe(1);
    expect(prepared.result.notices).toEqual([
      "SKU-gone: varianta již není v nabídce.",
      expect.stringMatching(/^SKU-a: přidáno 1\s000 z 2\s000 ks/),
    ]);
    expect(prepareReorder(createEmptyCart(), resolution, en).result.notices[0]).toBe(
      "SKU-gone: this variant is no longer offered.",
    );
  });

  it("accepts only well-formed route bodies", () => {
    expect(parseReorderResolution({ items: [], skipped: [] })).toEqual({ items: [], skipped: [] });
    expect(parseReorderResolution({ items: [{ productId: "p" }], skipped: [] })).toBeNull();
    expect(parseReorderResolution({ items: [], skipped: [{ sku: "x", reason: "x" }] })).toBeNull();
    expect(parseReorderResolution(null)).toBeNull();
  });
});

describe("POST /api/ontos/account/reorder", () => {
  const account = { id: "acc", partyId: "party", tenantId: "t", email: "a@b.cz", name: "A" };
  const order: CustomerOrder = {
    id: "o1",
    customerAccountId: account.id,
    number: "OBJ-1",
    status: "NEW",
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: "2026-11-19T10:00:00.000Z",
    totalMinor: 1980,
    totalVatMinor: 344,
    lines: [orderLine("a", 20)],
  };
  const context = {
    apiBaseUrl: "/shell-super-app-api/commerce-customer-context",
    compositionRevision: "a".repeat(64),
    token: "reorder-session-assertion",
    expiresAt: 4_102_444_800_000,
  };
  let network: Awaited<ReturnType<typeof serveHttp>>;
  const request = (body: unknown, origin?: string, cookie = "commerce-portal.session=admitted") =>
    fetch(`${network.origin}/api/ontos/account/reorder`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: origin ?? network.origin,
        [MARKET_LOCALE_HEADER]: "cs",
        cookie,
      },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    network = await serveHttp(async (incoming) => {
      const path = new URL(incoming.url).pathname;
      if (path === "/api/ontos/account/reorder") {
        const requestContext = nextRequest(incoming.url, {
          method: incoming.method,
          headers: incoming.headers,
          body: await incoming.text(),
        });
        try {
          return await requestContext.run(() => POST(requestContext.request));
        } finally {
          await requestContext.close();
        }
      }
      if (path === "/shell-super-app-api/auth/api-key/gateway-context")
        return Response.json(context);
      if (path === `${context.apiBaseUrl}/api/portal-auth/customer-account`)
        return incoming.headers.get("cookie") === "commerce-portal.session=admitted"
          ? Response.json({ state: "authenticated", account })
          : Response.json({ state: "anonymous" }, { status: 401 });
      if (path === "/shell-super-app-api/auth/api-key/gateway-read") {
        const payload: unknown = await incoming.json();
        const headers = { "x-ontos-gateway-context": JSON.stringify(context) };
        if (payload && typeof payload === "object" && "audience" in payload) {
          if (payload.audience === "commerce-market-catalog")
            return Response.json({ markets: [], associations: [] }, { headers });
          if (payload.audience === "merchandise" && "query" in payload) {
            const query = payload.query;
            if (query && typeof query === "object" && "view" in query) {
              const view = query.view;
              if (view && typeof view === "object") {
                if ("storefrontCustomerOrders" in view) {
                  const selection = view.storefrontCustomerOrders;
                  const found =
                    selection &&
                    typeof selection === "object" &&
                    "customerAccountId" in selection &&
                    selection.customerAccountId === account.id &&
                    "orderId" in selection &&
                    selection.orderId === order.id;
                  return Response.json(
                    { orders: found ? [order] : [], totalOrders: found ? 1 : 0 },
                    { headers },
                  );
                }
                if ("storefrontCatalog" in view)
                  return Response.json(catalogRecords(variantRecord("a")), { headers });
              }
            }
          }
        }
      }
      return Response.json({ message: `Unexpected request: ${path}` }, { status: 404 });
    });
    vi.stubEnv("ONTOS_SHELL_URL", network.origin);
    vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "reorder-test-key");
  });

  afterEach(async () => {
    try {
      await network.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads the order of the admitted session only and resolves it against the catalogue", async () => {
    const response = await request({ orderId: "o1", customerAccountId: "someone-else" });
    expect(response.status).toBe(200);
    const body = await response.json();
    await network.idle();
    const accountRequests = network.requests.filter((entry) =>
      new URL(entry.url).pathname.endsWith("/api/portal-auth/customer-account"),
    );
    expect(accountRequests).toHaveLength(1);
    expect(accountRequests[0].headers.get("cookie")).toBe("commerce-portal.session=admitted");
    const reads = await Promise.all(
      network.requests
        .filter((entry) => new URL(entry.url).pathname.endsWith("/auth/api-key/gateway-read"))
        .map((entry) => entry.json()),
    );
    const orderReads = reads.filter((entry) => entry.query?.view?.storefrontCustomerOrders);
    expect(orderReads).toHaveLength(1);
    expect(orderReads[0]).toMatchObject({
      audience: "merchandise",
      readName: "records",
      query: {
        view: {
          storefront: true,
          storefrontCustomerOrders: {
            customerAccountId: account.id,
            orderId: "o1",
            offset: 0,
          },
        },
      },
    });
    expect(reads).toContainEqual(
      expect.objectContaining({
        audience: "merchandise",
        query: {
          view: {
            storefront: true,
            storefrontCatalog: {
              productIds: ["p"],
              variantIds: ["a"],
              pageSize: 1,
              fields: "full",
              includeCategories: false,
            },
          },
        },
      }),
    );
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ variantId: "a", quantity: 20, priceMinor: 121 });
  });

  it("refuses guests, foreign origins and unknown orders", async () => {
    expect(
      (await request({ orderId: "o1" }, undefined, "commerce-portal.session=guest")).status,
    ).toBe(401);
    expect((await request({ orderId: "o1" }, "https://evil.test")).status).toBe(403);
    expect((await request({})).status).toBe(400);
    expect((await request({ orderId: "missing" })).status).toBe(404);
  });
});
