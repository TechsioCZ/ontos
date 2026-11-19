// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const origin = "https://store.test";
const legalEntityId = "71000000-0000-4000-8000-000000000024";
const appId = "akros-storefront";
const effectivePeriod = { startsAt: "2000-01-01T00:00:00.000Z" };
const markets = [
  { locale: "cs", lifecycle: "ACTIVE" },
  { locale: "sk", lifecycle: "ACTIVE" },
  { locale: "en", lifecycle: "ACTIVE" },
  { locale: "pl", lifecycle: "SUSPENDED" },
].map(({ locale, lifecycle }, index) => ({
  marketRef: { resourceId: `72000000-0000-4000-8000-00000000000${index}` },
  sellingLegalEntityRef: { resourceId: legalEntityId },
  marketCode: locale.toUpperCase(),
  supportedLocales: [locale],
  lifecycle,
  effectivePeriod,
}));
const catalog = {
  markets,
  associations: markets.map(({ marketRef, sellingLegalEntityRef }) => ({
    marketRef,
    sellingLegalEntityRef,
    storefrontRef: { appId, tenantId: "market-proxy-test" },
    channel: "B2C",
    effectivePeriod,
  })),
};

let network: Awaited<ReturnType<typeof serveHttp>>;
let proxy: typeof import("@/proxy").proxy;
let ownerUnavailable = false;
const run = async (path: string, headers: Record<string, string> = {}) => {
  const context = nextRequest(new URL(path, origin).href, { headers });
  try {
    return await context.run(() => proxy(context.request));
  } finally {
    await context.close();
    await network.idle();
  }
};
const rewrite = (response: Response) => response.headers.get("x-middleware-rewrite");
const forwarded = (response: Response, header: string) =>
  response.headers.get(`x-middleware-request-${header}`);

beforeEach(async () => {
  // Reload the real modules to isolate their process-local market cache between cases.
  vi.resetModules();
  ownerUnavailable = false;
  network = await serveHttp(() =>
    ownerUnavailable
      ? Response.json({ code: "owner_unavailable" }, { status: 500 })
      : Response.json(catalog, {
          headers: {
            "x-ontos-gateway-context": JSON.stringify({
              apiBaseUrl: "/shell-super-app-api/module-api/commerce-market-catalog",
              compositionRevision: "a".repeat(64),
              token: "market-proxy-read",
              expiresAt: Math.floor(Date.now() / 1000) + 300,
            }),
          },
        }),
  );
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "market-proxy-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", appId);
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  ({ proxy } = await import("@/proxy"));
});

afterEach(async () => {
  try {
    await network.idle();
    for (const request of network.requests) {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/shell-super-app-api/auth/api-key/gateway-read");
      expect(request.headers.get("x-api-key")).toBe("market-proxy-test-key");
      expect(await request.json()).toEqual({
        audience: "commerce-market-catalog",
        legalEntityId,
        readName: "current-market-catalog",
        query: { at: expect.any(String) },
      });
    }
  } finally {
    await network.close();
    vi.unstubAllEnvs();
  }
});

describe("market routing proxy", () => {
  it.each([
    ["/", "/cs"],
    ["/kategorie/srouby", "/cs/kategorie/srouby"],
    ["/produkt/vrut?variant=3%2C5", "/cs/produkt/vrut?variant=3%2C5"],
    ["/faq", "/cs/faq"],
    ["/srouby", "/cs/srouby"],
    ["/kosik/shrnuti", "/cs/kosik/shrnuti"],
  ])("redirects the legacy URL %s permanently into the Czech market", async (path, target) => {
    const response = await run(path);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`${origin}${target}`);
    expect(network.requests).toHaveLength(0);
  });

  it.each([
    "/api/ontos/cart",
    "/_next/static/chunks/main.js",
    "/robots.txt",
    "/icon.svg",
    "/akros/logo-akros.png",
    "/commerce-customer-context-api/api/portal-auth/verify-email?token=one-use",
  ])("passes %s through without a market", async (path) => {
    const response = await run(path);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(rewrite(response)).toBeNull();
    expect(network.requests).toHaveLength(0);
  });

  it.each([
    ["/sk/kategorie/srouby?page=2", "sk", "/kategorie/srouby?page=2", "/kategorie/srouby"],
    ["/cs", "cs", "/", "/"],
    ["/en/produkt/vrut?variant=x", "en", "/produkt/vrut?variant=x", "/produkt/vrut"],
    ["/cs/faq", "cs", "/faq", "/faq"],
  ])(
    "rewrites %s to the existing route with its market locale",
    async (path, locale, target, store) => {
      const response = await run(path);
      expect(network.requests).toHaveLength(1);
      expect(response.status).toBe(200);
      expect(rewrite(response)).toBe(`${origin}${target}`);
      expect(forwarded(response, "x-akros-market-locale")).toBe(locale);
      expect(forwarded(response, "x-akros-store-path")).toBe(store);
    },
  );

  it("overwrites a browser-sent market header with the path locale", async () => {
    const response = await run("/sk/kosik", { "x-akros-market-locale": "cs" });
    expect(network.requests).toHaveLength(1);
    expect(forwarded(response, "x-akros-market-locale")).toBe("sk");
  });

  it("sends an unknown locale to the root 404 and an inactive market to its unavailable page", async () => {
    const unknown = await run("/de/kategorie/srouby");
    expect(rewrite(unknown)).toBe(`${origin}/_unknown-market`);
    expect(forwarded(unknown, "x-akros-market-locale")).toBe("de");
    const inactive = await run("/pl");
    expect(rewrite(inactive)).toBe(`${origin}/trh-nedostupny`);
    expect(forwarded(inactive, "x-akros-market-locale")).toBe("pl");
    expect(network.requests).toHaveLength(1);
  });

  it("leaves an OntOS outage to the page render instead of reporting an unknown market", async () => {
    ownerUnavailable = true;
    const response = await run("/sk/kosik");
    expect(rewrite(response)).toBe(`${origin}/kosik`);
    expect(network.requests).toHaveLength(1);
    expect(forwarded(response, "x-akros-market-locale")).toBe("sk");
  });
});
