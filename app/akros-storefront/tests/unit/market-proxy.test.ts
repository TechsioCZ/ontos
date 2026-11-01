import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storefrontMarketKind } from "@/ontos/market";
import { proxy } from "@/proxy";

vi.mock("@/ontos/market", () => ({ storefrontMarketKind: vi.fn<typeof storefrontMarketKind>() }));

const origin = "https://store.test";
const run = (path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(new URL(path, origin), { headers }));
const rewrite = (response: Response) => response.headers.get("x-middleware-rewrite");
const forwarded = (response: Response, header: string) =>
  response.headers.get(`x-middleware-request-${header}`);

beforeEach(() => {
  vi.mocked(storefrontMarketKind).mockReset();
  vi.mocked(storefrontMarketKind).mockImplementation(async (locale) =>
    locale === "pl" ? "not-active" : ["cs", "sk", "en"].includes(locale) ? "live" : "unknown",
  );
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
    expect(storefrontMarketKind).not.toHaveBeenCalled();
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
    expect(storefrontMarketKind).not.toHaveBeenCalled();
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
      expect(response.status).toBe(200);
      expect(rewrite(response)).toBe(`${origin}${target}`);
      expect(forwarded(response, "x-akros-market-locale")).toBe(locale);
      expect(forwarded(response, "x-akros-store-path")).toBe(store);
    },
  );

  it("overwrites a browser-sent market header with the path locale", async () => {
    const response = await run("/sk/kosik", { "x-akros-market-locale": "cs" });
    expect(forwarded(response, "x-akros-market-locale")).toBe("sk");
  });

  it("sends an unknown locale to the root 404 and an inactive market to its unavailable page", async () => {
    const unknown = await run("/de/kategorie/srouby");
    expect(rewrite(unknown)).toBe(`${origin}/_akros-unknown-market`);
    expect(forwarded(unknown, "x-akros-market-locale")).toBe("de");
    const inactive = await run("/pl");
    expect(rewrite(inactive)).toBe(`${origin}/trh-nedostupny`);
    expect(forwarded(inactive, "x-akros-market-locale")).toBe("pl");
  });

  it("leaves an OntOS outage to the page render instead of reporting an unknown market", async () => {
    vi.mocked(storefrontMarketKind).mockRejectedValue(new Error("unreachable"));
    const response = await run("/sk/kosik");
    expect(rewrite(response)).toBe(`${origin}/kosik`);
    expect(forwarded(response, "x-akros-market-locale")).toBe("sk");
  });
});
