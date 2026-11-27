// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const tenantId = "bceaa540-13eb-5508-9ac0-9ed7e40a2ee9";
const legalEntityId = "c0c78a3e-6e2a-57e0-9d0d-86253499fee7";
const productRef = {
  moduleId: "commerce.catalog",
  resourceType: "commerce.catalog.product",
  tenantId,
  resourceId: "10000000-0000-4000-8000-000000000001",
};
const offer = {
  customerConfigurationId: "akros-eshop",
  channelId: "B2C",
  marketId: "akros-cz",
  currencyCode: "CZK",
  unitId: "30000000-0000-4000-8000-000000000001",
  unitQuantity: "1",
};
const localized = { kind: "PRESENT", locale: "cs", name: "Imported product" };
const reference = (index: number) => ({
  moduleId: "commerce.catalog",
  resourceType: "commerce.catalog.variant",
  tenantId,
  resourceId: `variant-${index}`,
});

type Join = { audience: string; refs: unknown[]; requestIndex: number };
let server: typeof import("@/ontos/erp-catalogue-server");
let network: Awaited<ReturnType<typeof serveHttp>>;
let joins: Join[];
let variantCount: number;
let oversizedStock: boolean;
let active: number;
let peak: number;
let hold: boolean;
let marketReads: number;
let release: ReturnType<typeof Promise.withResolvers<void>>;
let started: ReturnType<typeof Promise.withResolvers<void>>;
let lifecycle: string;
let slowCatalog: Promise<void> | undefined;

beforeEach(async () => {
  vi.resetModules();
  joins = [];
  variantCount = 500;
  oversizedStock = false;
  active = 0;
  peak = 0;
  hold = false;
  marketReads = 0;
  lifecycle = "DRAFT";
  slowCatalog = undefined;
  release = Promise.withResolvers<void>();
  started = Promise.withResolvers<void>();
  network = await serveHttp(async (request) => {
    const requestIndex = network.requests.length - 1;
    const path = new URL(request.url).pathname;
    const context = {
      apiBaseUrl: "/shell-super-app-api/erp",
      token: "erp-read-once",
      compositionRevision: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
    };
    const headers = { "x-ontos-gateway-context": JSON.stringify(context) };
    if (path.endsWith("/gateway-context")) return Response.json(context);
    const body = await request.json();
    const portal = path.endsWith("/api/portal-auth/catalog-page-prices");
    if (!portal && body.audience === "commerce-market-catalog") {
      marketReads += 1;
      return Response.json({ markets: [], associations: [] }, { headers });
    }
    if (!portal && body.audience === "catalog") {
      await slowCatalog;
      return Response.json(
        {
          count: 1,
          items: [
            {
              productRef,
              lifecycle,
              localized,
              categories: [],
              media: [],
              variants: Array.from({ length: variantCount }, (_, index) => ({
                variantRef: reference(index),
                lifecycle: "ACTIVE",
                localized,
                options: [],
              })),
            },
          ],
        },
        { headers },
      );
    }
    const audience = portal ? "customer-pricing" : body.audience;
    const query = portal ? body : body.query;
    const refs: unknown[] =
      audience === "inventory"
        ? query.variantRefs
        : query.items.map(
            (item: { catalogSelection: { variantRef: unknown } }) =>
              item.catalogSelection.variantRef,
          );
    joins.push({ audience, refs, requestIndex });
    active += 1;
    peak = Math.max(peak, active);
    if (joins.length === 4) started.resolve();
    try {
      if (hold) await release.promise;
      if (audience === "inventory")
        return Response.json(
          {
            items: [...refs, ...(oversizedStock ? [reference(0)] : [])].map((variantRef) => ({
              outcome: "ON_HAND",
              variantRef,
              total: { amount: "5" },
            })),
          },
          { headers },
        );
      return Response.json(
        {
          _tag: "CATALOG_PAGE_PRICED",
          prices: refs.map((variantRef) => ({
            _tag: "PRICE_FOUND",
            catalogSelection: { productRef, variantRef },
            priceGroupSelector: { kind: portal ? "PRICE_GROUP" : "NO_GROUP" },
            priceRevision: { monetaryAmount: { amount: portal ? "9" : "10", currencyCode: "CZK" } },
          })),
        },
        { headers },
      );
    } finally {
      active -= 1;
    }
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "erp-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  vi.stubEnv("ONTOS_STOREFRONT_ERP_OFFERS", JSON.stringify({ [legalEntityId]: offer }));
  server = await import("@/ontos/erp-catalogue-server");
});
afterEach(async () => {
  release.resolve();
  await network.idle();
  await network.close();
  vi.unstubAllEnvs();
});
const read = async (signal?: AbortSignal, customer = false) => {
  const context = nextRequest(`${network.origin}/cs`, {
    headers: {
      host: new URL(network.origin).host,
      "x-akros-market-locale": "cs",
      ...(customer ? { cookie: "commerce-portal.session=customer-session" } : {}),
    },
  });
  try {
    return await context.run(() => server.readErpCataloguePage(0, 48, { signal }));
  } finally {
    await context.close();
  }
};

describe("bounded ERP owner joins", () => {
  it.each([false, true])(
    "reuses the layout market for listing and detail (same signal=%s)",
    async (sameSignal) => {
      variantCount = 1;
      const { createOperation } = await import("@/ontos/gateway");
      const { getActiveMarket, marketReadsFor } = await import("@/ontos/active-market");
      const operation = Effect.runSync(createOperation());
      const context = nextRequest(`${network.origin}/cs`, {
        headers: { host: new URL(network.origin).host, "x-akros-market-locale": "cs" },
      });
      try {
        await context.run(async () => {
          // The root layout resolves first. Both ERP readers must observe that same request snapshot.
          await getActiveMarket(marketReadsFor(operation));
          const options = { operation, ...(sameSignal ? { signal: operation.signal } : {}) };
          await server.readErpCataloguePage(0, 48, options);
          await server.readErpProduct(productRef.resourceId, options);
        });
        expect(marketReads).toBe(1);
      } finally {
        operation.dispose();
        await context.close();
      }
    },
  );

  it("shares four lazy workers across stock and guest prices and preserves every bounded chunk", async () => {
    hold = true;
    const pending = read();
    await started.promise;
    expect(joins.map(({ audience }) => audience).sort()).toEqual([
      "inventory",
      "inventory",
      "pricing",
      "pricing",
    ]);
    expect(peak).toBe(server.ERP_JOIN_CONCURRENCY);
    release.resolve();
    const answer = await pending;
    expect(answer.products[0]?.variants).toHaveLength(500);
    expect(joins).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(server.ERP_JOIN_CONCURRENCY);
    expect(joins.every(({ refs }) => refs.length === 100)).toBe(true);
    expect(answer.products[0]?.variants[0]?.price).toEqual({
      kind: "price",
      amount: "10",
      currencyCode: "CZK",
      yours: false,
    });
  });

  it.each([false, true])(
    "cancels active joins and stops undispatched chunks (customer=%s)",
    async (customer) => {
      hold = true;
      const controller = new AbortController();
      const pending = read(controller.signal, customer);
      // Register the failure expectation before aborting; no unhandled rejection hides a dispatch leak.
      const rejected = expect(pending).rejects.toMatchObject({ kind: "cancelled" });
      await started.promise;
      const dispatched = [...joins];
      controller.abort();
      await rejected;
      await Promise.all(dispatched.map(({ requestIndex }) => network.aborts[requestIndex]));
      expect(joins).toHaveLength(server.ERP_JOIN_CONCURRENCY);
      if (customer) expect(joins.some(({ audience }) => audience === "pricing")).toBe(false);
      release.resolve();
    },
  );

  it("keeps customer group prices without asking for guest prices", async () => {
    variantCount = 1;
    const answer = await read(undefined, true);
    expect(joins.map(({ audience }) => audience).sort()).toEqual(["customer-pricing", "inventory"]);
    expect(answer.products[0]?.variants[0]?.price).toEqual({
      kind: "price",
      amount: "9",
      currencyCode: "CZK",
      yours: true,
    });
  });

  it("refuses an excessive reference set before dispatching any stock or pricing chunk", async () => {
    variantCount = server.ERP_VARIANT_LIMIT + 1;
    await expect(read()).rejects.toMatchObject({ code: "erp_variants_oversize" });
    expect(joins).toEqual([]);
  });

  it("refuses output beyond the requested reference count", async () => {
    variantCount = 1;
    oversizedStock = true;
    await expect(read()).rejects.toMatchObject({ code: "erp_stock_oversize" });
  });
});

describe("ERP header search", () => {
  const search = async (query: string, ms: number) => {
    const context = nextRequest(`${network.origin}/cs`, {
      headers: { host: new URL(network.origin).host, "x-akros-market-locale": "cs" },
    });
    const { createOperation } = await import("@/ontos/gateway");
    const operation = Effect.runSync(createOperation());
    try {
      return await context.run(() => server.searchErpProductsWithin(query, 4, operation, ms));
    } finally {
      operation.dispose();
      await context.close();
    }
  };

  it("finds the product in the last snapshot when its fresh read is slower than the search limit", async () => {
    variantCount = 1;
    lifecycle = "ACTIVE";
    expect(await search("imported", 5_000)).toMatchObject({ count: 1, partial: false });
    const slow = Promise.withResolvers<void>();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The snapshot is too old to be served as fresh, and its next read does not answer in time.
      vi.setSystemTime(Date.now() + 5_000);
      slowCatalog = slow.promise;
      const answer = await search("imported", 300);
      expect(answer.partial).toBe(false);
      expect(answer.products.map(({ id }) => id)).toEqual([productRef.resourceId]);
    } finally {
      vi.useRealTimers();
      slow.resolve();
    }
  });

  it("says the ERP part is missing when no snapshot was read in time", async () => {
    variantCount = 1;
    lifecycle = "ACTIVE";
    const slow = Promise.withResolvers<void>();
    slowCatalog = slow.promise;
    try {
      expect(await search("imported", 300)).toEqual({ count: 0, products: [], partial: true });
    } finally {
      slow.resolve();
    }
  });
});
