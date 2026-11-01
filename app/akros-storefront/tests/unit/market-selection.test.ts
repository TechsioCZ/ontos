import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MarketModule from "@/ontos/market";

// Shared across `vi.resetModules()`: every fresh market module reads through this mock.
const { AKROS, readRecords } = vi.hoisted(() => ({
  AKROS: "71000000-0000-4000-8000-000000000024",
  readRecords: vi.fn<(audience: string, readName: string, query: unknown) => Promise<unknown>>(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/ontos/config", () => ({
  getConfig: () => ({ legalEntityId: AKROS, apiKey: "test", shellUrl: "http://shell.test" }),
}));
vi.mock("@/ontos/gateway", async (original) => ({
  ...(await original<typeof import("@/ontos/gateway")>()),
  readRecords,
}));

const KAVARNA = "71000000-0000-4000-8000-000000000023";
const TENANT = "70000000-0000-4000-8000-000000000020";
const NOW = Date.parse("2026-11-02T10:00:00Z");

const ref = (resourceType: string, resourceId: string) => ({
  moduleId: "commerce.market-catalog",
  resourceType: `commerce.market-catalog.${resourceType}`,
  resourceId,
  tenantId: TENANT,
});
const seller = (resourceId = AKROS) => ({
  moduleId: "core.identity",
  resourceType: "core.identity.legal-entity",
  resourceId,
  tenantId: TENANT,
});
const market = (
  id: string,
  code: string,
  locales: string[],
  {
    lifecycle = "ACTIVE",
    country,
    legalEntity = AKROS,
    effectivePeriod = { startsAt: "2026-01-01T00:00:00Z" },
  }: {
    lifecycle?: string;
    country?: string;
    legalEntity?: string;
    effectivePeriod?: { startsAt: string; endsAt?: string };
  } = {},
) => ({
  channels: ["B2C"],
  definitionRevisionRef: ref("market-definition-revision", `${id}-r1`),
  effectivePeriod,
  jurisdictions: country ? [{ kind: "COUNTRY", code: country }] : [{ kind: "REGION", code: "EU" }],
  lifecycle,
  marketCode: code,
  marketRef: ref("market", id),
  purpose: code,
  revision: 1,
  sellingLegalEntityRef: seller(legalEntity),
  supportedLocales: locales,
});
const association = (
  marketId: string,
  {
    appId = "akros-storefront",
    channel = "B2C",
    legalEntity = AKROS,
    effectivePeriod = { startsAt: "2026-01-01T00:00:00Z" } as { startsAt: string; endsAt?: string },
  } = {},
) => ({
  associationRef: ref("storefront-association", `${marketId}-a`),
  channel,
  effectivePeriod,
  marketDefinitionRevisionRef: ref("market-definition-revision", `${marketId}-r1`),
  marketRef: ref("market", marketId),
  provenance: { kind: "CONFIGURATION_ACTION", reference: "seed" },
  revision: 1,
  sellingLegalEntityRef: seller(legalEntity),
  storefrontRef: { appId, tenantId: TENANT },
});

const catalog = {
  markets: [
    market("m-cz", "AKROS-CZ", ["cs"], { country: "CZ" }),
    market("m-sk", "AKROS-SK", ["sk"], { country: "SK" }),
    market("m-eu", "AKROS-EU", ["en"]),
    market("m-pl", "AKROS-PL", ["pl"], { country: "PL", lifecycle: "SUSPENDED" }),
    market("m-at", "AKROS-AT", ["de"], { country: "AT", lifecycle: "RETIRED" }),
    market("m-b2b", "AKROS-CZ-B2B", ["cs"], { country: "CZ" }),
    market("m-kav", "KAVARNA-CZ", ["cs"], { country: "CZ", legalEntity: KAVARNA }),
    market("m-hu", "AKROS-HU", ["hu"], { country: "HU" }),
  ],
  associations: [
    association("m-cz"),
    association("m-sk"),
    association("m-eu"),
    association("m-pl"),
    // The B2B market is associated for the B2B channel only.
    association("m-b2b", { channel: "B2B" }),
    association("m-kav", { appId: "kavarna-doma-eshop", legalEntity: KAVARNA }),
    // An association that ended yesterday.
    association("m-hu", {
      effectivePeriod: { startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" },
    }),
  ],
  completenessEvidence: {},
  observedAt: "2026-11-02T10:00:00Z",
};

const currencies: Record<string, string> = { "m-cz": "CZK", "m-sk": "EUR", "m-eu": "EUR" };

let market$: typeof MarketModule;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  readRecords.mockReset();
  readRecords.mockImplementation(async (audience, readName, query) => {
    const body = query as { view: { storefrontCatalog: { marketId: string } } };
    if (audience === "commerce-market-catalog" && readName === "current-market-catalog")
      return catalog;
    if (audience === "merchandise") {
      const marketId = body.view.storefrontCatalog.marketId;
      return {
        products: [],
        market: {
          marketId,
          marketCode: marketId,
          currency: currencies[marketId],
          configured: marketId !== "m-eu",
        },
      };
    }
    throw new Error(`unexpected read ${audience}/${readName}`);
  });
  market$ = await import("@/ontos/market");
});
afterEach(() => vi.useRealTimers());

describe("storefront market directory", () => {
  it("keeps only this storefront's B2C associations of the AKROS seller that are effective now", () => {
    const entries = market$.storefrontMarkets(catalog, NOW, AKROS);
    expect(
      entries.map((entry) => [entry.marketCode, entry.locale, entry.lifecycle, entry.label]),
    ).toEqual([
      ["AKROS-CZ", "cs", "ACTIVE", "CZ"],
      ["AKROS-EU", "en", "ACTIVE", "EN"],
      ["AKROS-PL", "pl", "SUSPENDED", "PL"],
      ["AKROS-SK", "sk", "ACTIVE", "SK"],
    ]);
  });

  it("uses the language subtag of the primary locale as the path and prefers an active market", () => {
    const entries = market$.storefrontMarkets(
      {
        markets: [
          market("m-de-old", "AKROS-AT", ["de-AT", "en"], { lifecycle: "SUSPENDED" }),
          market("m-de", "AKROS-DE", ["de-DE"]),
        ],
        associations: [association("m-de-old"), association("m-de")],
      },
      NOW,
      AKROS,
    );
    expect(entries).toEqual([
      expect.objectContaining({ marketCode: "AKROS-DE", locale: "de", formatLocale: "de-DE" }),
    ]);
  });
});

describe("market resolution", () => {
  it("resolves a live market with its merchandise currency and offer state", async () => {
    const resolution = await market$.resolveStorefrontMarket("sk");
    expect(resolution).toEqual({
      kind: "live",
      market: {
        marketId: "m-sk",
        marketCode: "AKROS-SK",
        locale: "sk",
        formatLocale: "sk",
        currency: "EUR",
        configured: true,
      },
      live: [
        { locale: "cs", marketCode: "AKROS-CZ", label: "CZ", currency: "CZK" },
        { locale: "en", marketCode: "AKROS-EU", label: "EN", currency: "EUR" },
        { locale: "sk", marketCode: "AKROS-SK", label: "SK", currency: "EUR" },
      ],
    });
    expect(readRecords).toHaveBeenCalledWith("commerce-market-catalog", "current-market-catalog", {
      at: "2026-11-02T10:00:00.000Z",
    });
    expect(
      readRecords.mock.calls.map(([audience, readName]) => `${audience}/${readName}`),
    ).not.toContain("commerce-market-catalog/resolve-commerce-market");
  });

  it("reports a market without a configured offer", async () => {
    const resolution = await market$.resolveStorefrontMarket("en");
    expect(resolution.kind === "live" && resolution.market).toMatchObject({
      currency: "EUR",
      configured: false,
    });
  });

  it("reports a suspended market as temporarily unavailable, listing the live markets", async () => {
    const resolution = await market$.resolveStorefrontMarket("pl");
    expect(resolution).toMatchObject({ kind: "not-active", locale: "pl", marketCode: "AKROS-PL" });
    expect(resolution.live.map((entry) => entry.locale)).toEqual(["cs", "en", "sk"]);
    expect(await market$.storefrontMarketKind("pl")).toBe("not-active");
  });

  it.each([
    ["de", "a retired market without an association"],
    ["hu", "a market whose association ended"],
    ["fr", "a locale no market uses"],
    ["", "a request without a locale"],
  ])("treats %s (%s) as unknown", async (locale) => {
    const resolution = await market$.resolveStorefrontMarket(locale);
    expect(resolution.kind).toBe("unknown");
    expect(resolution.live.map((entry) => entry.locale)).toEqual(["cs", "en", "sk"]);
  });

  it("caches the market catalog for 60 seconds", async () => {
    await market$.resolveStorefrontMarket("cs");
    await market$.resolveStorefrontMarket("sk");
    const catalogReads = () =>
      readRecords.mock.calls.filter(([, readName]) => readName === "current-market-catalog").length;
    expect(catalogReads()).toBe(1);
    vi.setSystemTime(NOW + 61_000);
    await market$.resolveStorefrontMarket("cs");
    expect(catalogReads()).toBe(2);
  });

  it("requires merchandise to answer for the requested market in a supported currency", () => {
    expect(
      market$.marketOfferOf({ market: { marketId: "m-sk", currency: "EUR" } }, "m-sk"),
    ).toEqual({
      currency: "EUR",
      configured: true,
    });
    expect(() => market$.marketOfferOf({ products: [] }, "m-sk")).toThrow(/no market/);
    expect(() =>
      market$.marketOfferOf({ market: { marketId: "m-sk", currency: "USD" } }, "m-sk"),
    ).toThrow(/no market/);
  });
});

describe("before any market exists", () => {
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
  const catalogReads = () =>
    readRecords.mock.calls.filter(([, readName]) => readName === "current-market-catalog").length;

  it("serves /cs as the Czech CZK catalogue without a market when the catalog is empty", async () => {
    readRecords.mockImplementation(async (_audience, readName) => {
      if (readName === "current-market-catalog")
        return { ...catalog, markets: [], associations: [] };
      throw new Error(`unexpected read ${readName}`);
    });
    expect(await market$.resolveStorefrontMarket("cs")).toEqual(unmarketed);
    expect(await market$.storefrontMarketKind("cs")).toBe("live");
    expect(await market$.storefrontMarketKind("sk")).toBe("unknown");
    expect(await market$.resolveStorefrontMarket("sk")).toMatchObject({
      kind: "unknown",
      live: unmarketed.live,
    });
    // No resolution and no merchandise read: nothing to resolve yet.
    expect(readRecords).toHaveBeenCalledTimes(1);
  });

  it("ignores other sellers' markets and other storefronts' associations", async () => {
    readRecords.mockImplementation(async () => ({
      markets: [market("m-kav", "KAVARNA-CZ", ["cs"], { country: "CZ", legalEntity: KAVARNA })],
      associations: [association("m-kav", { appId: "kavarna-doma-eshop", legalEntity: KAVARNA })],
    }));
    expect(await market$.resolveStorefrontMarket("cs")).toEqual(unmarketed);
  });

  it("keeps serving the owners' markets once one exists, even if none is live", async () => {
    readRecords.mockImplementation(async (_audience, readName) => {
      if (readName === "current-market-catalog")
        return {
          markets: [market("m-at", "AKROS-AT", ["de"], { lifecycle: "RETIRED" })],
          associations: [],
        };
      throw new Error(`unexpected read ${readName}`);
    });
    expect(await market$.resolveStorefrontMarket("cs")).toEqual({
      kind: "unknown",
      locale: "cs",
      live: [],
    });
  });

  it.each([
    [
      "the market owner is not active (gateway audience rejected)",
      400,
      "GatewayAudienceInvalidProblem",
    ],
    ["the read is not granted to the storefront", 403, "CurrentMarketCatalogForbiddenProblem"],
  ])("serves /cs without a market when %s, cached for 60 seconds", async (_case, status, tag) => {
    const { OntosError } = await import("@/ontos/gateway");
    readRecords.mockImplementation(async () => {
      throw new OntosError("rejected", status, undefined, undefined, { _tag: tag });
    });
    expect(await market$.resolveStorefrontMarket("cs")).toEqual(unmarketed);
    expect(await market$.storefrontMarketKind("en")).toBe("unknown");
    expect(catalogReads()).toBe(1);
  });

  it("reports a market owner outage instead of falling back", async () => {
    const { OntosError } = await import("@/ontos/gateway");
    readRecords.mockImplementation(async () => {
      throw new OntosError("down", 503, "backend_unreachable");
    });
    await expect(market$.resolveStorefrontMarket("cs")).rejects.toThrow(/down/);
    readRecords.mockImplementation(async () => {
      throw new OntosError("bad request", 400, undefined, undefined, { _tag: "OtherProblem" });
    });
    await expect(market$.resolveStorefrontMarket("cs")).rejects.toThrow(/bad request/);
  });
});
