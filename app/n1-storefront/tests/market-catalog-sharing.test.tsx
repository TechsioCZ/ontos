import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Effect, Schema } from "effect";
import type { ReactNode } from "react";
import actualReact from "react" with { rstest: "importActual" };
import LocaleLayout from "../src/app/[locale]/layout";
import { getCartScope } from "../src/ontos/cart-quote-server";
import { internalShellOrigin } from "../src/ontos/config";
import { storefrontRuntime } from "../src/ontos/runtime";

/**
 * React's server `cache()` semantics as Next's renderer provides them: one memo per request, found through an
 * async-local request store (so it survives awaits), and plain pass-through when no request is active, as in route
 * handlers and server actions. The client build of React that tests resolve is always pass-through.
 */
const server = rs.hoisted(() => {
  // Hoisted above the imports, so the Node built-in is taken from the process itself.
  const { AsyncLocalStorage } = process.getBuiltinModule("node:async_hooks");
  const requests = new AsyncLocalStorage<object>();
  const cache = <Args extends readonly (string | number)[], R>(fn: (...args: Args) => R) => {
    const perRequest = new WeakMap<object, Map<string, R>>();
    return (...args: Args): R => {
      const request = requests.getStore();
      if (request === undefined) {
        return fn(...args);
      }
      const memo = perRequest.get(request) ?? new Map<string, R>();
      perRequest.set(request, memo);
      const key = JSON.stringify(args);
      const hit = memo.get(key);
      if (hit !== undefined) {
        return hit;
      }
      const value = fn(...args);
      memo.set(key, value);
      return value;
    };
  };
  return { cache, requests };
});

rs.mock("react", () => ({ ...actualReact, cache: server.cache }));
rs.mock("server-only", () => ({}));
// Only the layout's owner reads are under test; its chrome and client providers are not rendered here.
rs.mock("../src/features/cart-provider", () => ({
  CartProvider: ({ children }: { children: ReactNode }) => children,
}));
rs.mock("../src/features/shell", () => ({
  StorefrontShell: ({ children }: { children: ReactNode }) => children,
}));

const tenantId = "70000000-0000-4000-8000-000000000099";
const legalEntityId = "71000000-0000-4000-8000-000000000099";
const marketId = "72000000-0000-4000-8000-000000000099";
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
      marketCode: "N1-CZ",
      marketRef: { resourceId: marketId },
      sellingLegalEntityRef: { resourceId: legalEntityId },
      supportedLocales: ["cs-CZ"],
    },
  ],
};
const records = {
  categories: [],
  market: { configured: true, currency: "CZK", marketId },
  products: [],
  revision: 4,
};
const gatewayContext = JSON.stringify({
  apiBaseUrl: "/shell-super-app-api/module-api/test",
  compositionRevision: "a".repeat(64),
  expiresAt: 9_999_999_999,
  token: "test-redeemed-context",
});

// The storefront runtime keeps the fetch it first sees, so one stand-in stays installed and each test swaps its owner.
let respond = (_request: Request): Promise<Response> => Promise.reject(new Error("no owner"));
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = async (url, init) => await respond(new Request(url, init));
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
interface OwnerOptions {
  /** Status of every `current-market-catalog` read; 200 when absent. */
  readonly marketStatus?: number;
}
const owner = (options: OwnerOptions = {}) => {
  rs.stubEnv("ONTOS_N1_STOREFRONT_API_KEY", "sharing-test-key");
  rs.stubEnv("ONTOS_STOREFRONT_TENANT_ID", tenantId);
  rs.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  rs.stubEnv("ONTOS_SHELL_URL", internalShellOrigin);
  const reads: string[] = [];
  const urls: string[] = [];
  respond = async (request) => {
    urls.push(request.url);
    const body = Schema.decodeUnknownSync(Schema.Struct({ readName: Schema.String }))(
      await request.json(),
    );
    reads.push(body.readName);
    const market = body.readName === "current-market-catalog";
    const status = market ? (options.marketStatus ?? 200) : 200;
    return Response.json(market ? marketCatalog : records, {
      headers: status === 200 ? { "x-ontos-gateway-context": gatewayContext } : {},
      status,
    });
  };
  const count = (readName: string) => reads.filter((read) => read === readName).length;
  return { count, reads, urls };
};
const renderLayout = (locale = "cs") =>
  server.requests.run({}, async () => {
    await LocaleLayout({ children: null, params: Promise.resolve({ locale }) });
  });

beforeEach(() => {
  rs.spyOn(console, "log").mockImplementation(() => {
    // The per-read Info lines are covered by gateway-read.test.ts.
  });
  rs.spyOn(console, "warn").mockImplementation(() => {
    // Expected unavailable-catalogue warnings in the failure case.
  });
});
afterEach(() => {
  rs.restoreAllMocks();
  rs.unstubAllEnvs();
});

describe("one market catalogue read per request", () => {
  it("renders the locale layout with one market read shared by the catalogue and cart-scope chains", async () => {
    const upstream = owner();
    await renderLayout();
    expect(upstream.count("current-market-catalog")).toBe(1);
    expect(upstream.count("records")).toBe(2);
    expect(upstream.reads).toHaveLength(3);
    for (const url of upstream.urls) {
      expect(url).toBe(`${internalShellOrigin}/shell-super-app-api/auth/api-key/gateway-read`);
    }
  });

  it("never reuses a market read across two requests", async () => {
    const upstream = owner();
    await renderLayout();
    await renderLayout();
    expect(upstream.count("current-market-catalog")).toBe(2);
    expect(upstream.count("records")).toBe(4);
  });

  it("fails every chain on a failed shared read, after its usual retries, and the next request reads again", async () => {
    const failing = owner({ marketStatus: 503 });
    const scopes = await server.requests.run({}, async () => {
      await LocaleLayout({ children: null, params: Promise.resolve({ locale: "cs" }) });
      return await storefrontRuntime.runPromise(Effect.flip(getCartScope("cs")));
    });
    // One shared read with its usual two retries of a 503 (not one per chain), and no merchandise read at all:
    // the catalogue chain, the cart-scope chain and a later caller in the same request all see the failure.
    expect(failing.count("current-market-catalog")).toBe(3);
    expect(failing.count("records")).toBe(0);
    expect(scopes).toMatchObject({ diagnostic: "context-read-unavailable", state: "unavailable" });
    const recovered = owner();
    await renderLayout();
    expect(recovered.count("current-market-catalog")).toBe(1);
    expect(recovered.count("records")).toBe(2);
  });

  it("does not share a read between route-handler calls outside a render", async () => {
    const upstream = owner();
    await storefrontRuntime.runPromise(getCartScope("cs"));
    await storefrontRuntime.runPromise(getCartScope("cs"));
    expect(upstream.count("current-market-catalog")).toBe(2);
    expect(upstream.count("records")).toBe(2);
  });
});
