import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MarketModule from "@/ontos/market";

// Regression: a denied commerce.market-catalog read must not be mistaken for proof of a pre-market
// installation. The unrestricted /cs catalogue (no marketId, so no assortment filter in
// catalog-server.readCatalog) is only legitimate when the owner proves emptiness — a 200 with no
// markets and no associations — or when the module is not part of the approved Application
// Composition at all (400 GatewayAudienceInvalidProblem; see
// apps/shell-super-app/api/auth/gateway-issuer.ts). A 403/404 from the composed owner means markets
// may exist and be restricted: the storefront must surface the denial, never widen the catalogue.

// Shared across `vi.resetModules()`: every fresh market module reads through this mock.
const { AKROS, identity, readRecords } = vi.hoisted(() => ({
  AKROS: "71000000-0000-4000-8000-000000000024",
  identity: { appId: "akros-storefront", legalEntityId: "71000000-0000-4000-8000-000000000024" },
  readRecords: vi.fn<(audience: string, readName: string, query: unknown) => Promise<unknown>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/ontos/config", () => ({
  getConfig: () => ({ ...identity, apiKey: "test", shellUrl: "http://shell.test" }),
}));
vi.mock("@/ontos/gateway", async (original) => ({
  ...(await original<typeof import("@/ontos/gateway")>()),
  readRecords,
}));

const TENANT = "70000000-0000-4000-8000-000000000020";
const MARKET = "m-cz";
const NOW = Date.parse("2026-11-04T10:00:00Z");

const ref = (resourceType: string, resourceId: string) => ({
  moduleId: "commerce.market-catalog",
  resourceType: `commerce.market-catalog.${resourceType}`,
  resourceId,
  tenantId: TENANT,
});
const seller = {
  moduleId: "core.identity",
  resourceType: "core.identity.legal-entity",
  resourceId: AKROS,
  tenantId: TENANT,
};
/** One ACTIVE CZ market of this storefront: an existing restricted market. */
const catalog = {
  markets: [
    {
      channels: ["B2C"],
      effectivePeriod: { startsAt: "2026-01-01T00:00:00Z" },
      jurisdictions: [{ kind: "COUNTRY", code: "CZ" }],
      lifecycle: "ACTIVE",
      marketCode: "AKROS-CZ",
      marketRef: ref("market", MARKET),
      purpose: "AKROS-CZ",
      revision: 1,
      sellingLegalEntityRef: seller,
      supportedLocales: ["cs"],
    },
  ],
  associations: [
    {
      associationRef: ref("storefront-association", `${MARKET}-a`),
      channel: "B2C",
      effectivePeriod: { startsAt: "2026-01-01T00:00:00Z" },
      marketRef: ref("market", MARKET),
      sellingLegalEntityRef: seller,
      storefrontRef: { appId: identity.appId, tenantId: TENANT },
    },
  ],
  completenessEvidence: {},
  observedAt: "2026-11-04T10:00:00Z",
};
const offer = {
  market: { marketId: MARKET, marketCode: "AKROS-CZ", currency: "CZK", configured: true },
  products: [],
};
const unmarketed = {
  kind: "live",
  market: {
    marketCode: "",
    locale: "cs",
    formatLocale: "cs-CZ",
    currency: "CZK",
    configured: true,
  },
  live: [{ locale: "cs", marketCode: "", label: "CZ", currency: "CZK" }],
};

let market$: typeof MarketModule;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  readRecords.mockReset();
  market$ = await import("@/ontos/market");
});
afterEach(() => vi.useRealTimers());

const ownerReads = () =>
  readRecords.mock.calls.map(([audience, readName]) => `${audience}/${readName}`);

describe("legitimate pre-market installation", () => {
  it("serves /cs without a marketId only when the owner proves the catalogue is empty", async () => {
    readRecords.mockResolvedValue({
      markets: [],
      associations: [],
      completenessEvidence: {},
      observedAt: "2026-11-04T10:00:00Z",
    });
    expect(await market$.resolveStorefrontMarket("cs")).toEqual(unmarketed);
    expect(await market$.storefrontMarketKind("cs")).toBe("live");
    expect(await market$.storefrontMarketKind("sk")).toBe("unknown");
    // Nothing to scope: no catalogue read is attempted, let alone one without a marketId.
    expect(ownerReads()).toEqual(["commerce-market-catalog/current-market-catalog"]);
  });

  it("keeps /cs when the market module is not part of the approved composition", async () => {
    const { OntosError } = await import("@/ontos/gateway");
    readRecords.mockImplementation(async () => {
      throw new OntosError("audience rejected", 400, undefined, undefined, {
        _tag: "GatewayAudienceInvalidProblem",
      });
    });
    expect(await market$.resolveStorefrontMarket("cs")).toEqual(unmarketed);
    expect(await market$.storefrontMarketKind("sk")).toBe("unknown");
  });
});

describe("denied access to the market catalog", () => {
  it.each([
    ["the read is not granted", 403, "CurrentMarketCatalogForbiddenProblem"],
    ["the gateway refuses the storefront principal", 403, "GatewayForbiddenProblem"],
    ["the read is not part of the composed release", 404, "CurrentMarketCatalogNotFoundProblem"],
  ])(
    "refuses /cs instead of serving the unrestricted catalogue when %s",
    async (_case, status, tag) => {
      const { OntosError } = await import("@/ontos/gateway");
      readRecords.mockImplementation(async () => {
        throw new OntosError("denied", status, undefined, undefined, { _tag: tag });
      });
      await expect(market$.resolveStorefrontMarket("cs")).rejects.toMatchObject({ status });
      await expect(market$.storefrontMarketKind("cs")).rejects.toMatchObject({ status });
    },
  );

  it("refuses /cs when a denied read hides the markets the storefront already had", async () => {
    // The owner confirmed one active CZ market: every catalogue read is scoped by its marketId.
    readRecords.mockImplementation(async (audience, readName) => {
      if (audience === "commerce-market-catalog" && readName === "current-market-catalog")
        return catalog;
      if (audience === "merchandise" && readName === "records") return offer;
      throw new Error(`unexpected read ${audience}/${readName}`);
    });
    const first = await market$.resolveStorefrontMarket("cs");
    expect(first.kind === "live" && first.market.marketId).toBe(MARKET);

    // Access is revoked. After the 60 s directory cache expires, /cs must not silently answer with
    // the whole published catalogue because the denial cannot prove the market is gone.
    const { OntosError } = await import("@/ontos/gateway");
    readRecords.mockImplementation(async () => {
      throw new OntosError("denied", 403, undefined, undefined, {
        _tag: "CurrentMarketCatalogForbiddenProblem",
      });
    });
    vi.setSystemTime(NOW + 61_000);
    await expect(market$.resolveStorefrontMarket("cs")).rejects.toMatchObject({ status: 403 });
  });
});
