import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MarketModule from "@/ontos/market";

import { Schema } from "effect";
import { browserAt, serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const AKROS = "71000000-0000-4000-8000-000000000024";
const AKROS_STOREFRONT = { appId: "akros-storefront", legalEntityId: AKROS };
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
    // An association that ended before the explicit NOW and the real request time.
    association("m-hu", {
      effectivePeriod: { startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" },
    }),
  ],
  completenessEvidence: {},
  observedAt: "2026-11-02T10:00:00Z",
};

const currencies: Record<string, string> = {
  "m-cz": "CZK",
  "m-sk": "EUR",
  "m-eu": "EUR",
  "m-kav": "CZK",
};

const GatewayRead = Schema.Struct({
  audience: Schema.String,
  legalEntityId: Schema.String,
  readName: Schema.String,
  query: Schema.Unknown,
});
const OfferQuery = Schema.Struct({
  view: Schema.Struct({ storefrontCatalog: Schema.Struct({ marketId: Schema.String }) }),
});
const CatalogQuery = Schema.Struct({ at: Schema.String });

let market$: typeof MarketModule;
let network: Awaited<ReturnType<typeof serveHttp>>;
let reads: Array<Schema.Schema.Type<typeof GatewayRead>>;
let catalogBody: unknown;
let failure: { status: number; code: string; _tag?: string } | undefined;
let beforeOffer: ((marketId: string) => Promise<Response | undefined>) | undefined;
beforeEach(async () => {
  vi.resetModules();
  reads = [];
  catalogBody = catalog;
  failure = undefined;
  beforeOffer = undefined;
  network = await serveHttp(async (request) => {
    expect(new URL(request.url).pathname).toBe("/shell-super-app-api/auth/api-key/gateway-read");
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-api-key")).toBe("market-selection-key");
    const body = Schema.decodeUnknownSync(GatewayRead)(await request.json());
    expect(body.legalEntityId).toBe(process.env.ONTOS_STOREFRONT_LEGAL_ENTITY_ID);
    reads.push(body);
    if (failure !== undefined) return Response.json(failure, { status: failure.status });
    let response: unknown;
    if (body.audience === "commerce-market-catalog" && body.readName === "current-market-catalog") {
      Schema.decodeUnknownSync(CatalogQuery)(body.query);
      response = catalogBody;
    } else if (body.audience === "merchandise" && body.readName === "records") {
      const {
        view: {
          storefrontCatalog: { marketId },
        },
      } = Schema.decodeUnknownSync(OfferQuery)(body.query);
      const override = await beforeOffer?.(marketId);
      if (override) return override;
      response = {
        products: [],
        market: {
          marketId,
          marketCode: marketId,
          currency: currencies[marketId],
          configured: marketId !== "m-eu",
        },
      };
    } else {
      throw new Error(`unexpected read ${body.audience}/${body.readName}`);
    }
    return Response.json(response, {
      headers: {
        "x-ontos-gateway-context": JSON.stringify({
          apiBaseUrl: `/shell-super-app-api/module-api/${body.audience}`,
          compositionRevision: "a".repeat(64),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          token: `market-selection-${reads.length}`,
        }),
      },
    });
  });
  browserAt(network.origin);
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "market-selection-key");
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", AKROS_STOREFRONT.appId);
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", AKROS_STOREFRONT.legalEntityId);
  market$ = await import("@/ontos/market");
});
afterEach(async () => {
  vi.useRealTimers();
  try {
    await network.close();
  } finally {
    vi.unstubAllEnvs();
  }
});
const catalogReads = () =>
  reads.filter(({ readName }) => readName === "current-market-catalog").length;

describe("storefront market directory", () => {
  it("keeps only this storefront's B2C associations of the AKROS seller that are effective now", () => {
    const entries = market$.storefrontMarkets(catalog, NOW, AKROS_STOREFRONT);
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
      AKROS_STOREFRONT,
    );
    expect(entries).toEqual([
      expect.objectContaining({ marketCode: "AKROS-DE", locale: "de", formatLocale: "de-DE" }),
    ]);
  });
});

describe("configured storefront identity", () => {
  it("selects the markets of the configured app id and selling legal entity", async () => {
    vi.stubEnv("ONTOS_STOREFRONT_APP_ID", "kavarna-doma-eshop");
    vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", KAVARNA);
    const resolution = await market$.resolveStorefrontMarket("cs");
    expect(resolution.kind === "live" && resolution.market.marketCode).toBe("KAVARNA-CZ");
    expect(resolution.live.map((entry) => entry.marketCode)).toEqual(["KAVARNA-CZ"]);
    expect(await market$.storefrontMarketKind("sk")).toBe("unknown");
  });

  it("ignores this seller's markets associated with another storefront application", () => {
    expect(
      market$.storefrontMarkets(catalog, NOW, { appId: "other-storefront", legalEntityId: AKROS }),
    ).toEqual([]);
    expect(
      market$.hasMarketData(
        { markets: [], associations: [association("m-cz")] },
        { appId: "other-storefront", legalEntityId: AKROS },
      ),
    ).toBe(false);
  });
});

describe("market resolution", () => {
  it("resolves a live market with its merchandise currency and offer state", async () => {
    const startedAt = Date.now();
    const resolution = await market$.resolveStorefrontMarket("sk");
    const completedAt = Date.now();
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
    await network.idle();
    const directoryRead = reads.find(({ readName }) => readName === "current-market-catalog");
    expect(directoryRead).toMatchObject({
      audience: "commerce-market-catalog",
      readName: "current-market-catalog",
    });
    const { at } = Schema.decodeUnknownSync(CatalogQuery)(directoryRead?.query);
    expect(new Date(at).toISOString()).toBe(at);
    expect(Date.parse(at)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(at)).toBeLessThanOrEqual(completedAt);
    expect(reads.map(({ audience, readName }) => `${audience}/${readName}`)).not.toContain(
      "commerce-market-catalog/resolve-commerce-market",
    );
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

  it("reads the current directory and offers again for every independent operation", async () => {
    await market$.resolveStorefrontMarket("cs");
    await market$.resolveStorefrontMarket("sk");
    expect(catalogReads()).toBe(2);
    catalogBody = {
      markets: [market("m-sk", "AKROS-SK", ["sk"], { lifecycle: "SUSPENDED" })],
      associations: [association("m-sk")],
    };
    expect(await market$.resolveStorefrontMarket("sk")).toMatchObject({ kind: "not-active" });
    expect(catalogReads()).toBe(3);
  });

  it("reuses one directory and one selected offer across concurrent active and switcher reads", async () => {
    const operation = market$.createMarketReadOperation();
    const [active, chrome] = await Promise.all([
      market$.resolveActiveStorefrontMarket("sk", operation),
      market$.resolveStorefrontMarket("sk", operation),
    ]);
    expect(active.kind === "live" && active.market.currency).toBe("EUR");
    expect(chrome.kind).toBe("live");
    expect(catalogReads()).toBe(1);
    expect(reads.filter(({ audience }) => audience === "merchandise")).toHaveLength(3);
    expect(
      reads.filter(
        ({ audience, query }) =>
          audience === "merchandise" &&
          Schema.decodeUnknownSync(OfferQuery)(query).view.storefrontCatalog.marketId === "m-sk",
      ),
    ).toHaveLength(1);
  });

  it("resolves API active-market reads without reading other markets' offers", async () => {
    const { getActiveMarket } = await import("@/ontos/active-market");
    const request = nextRequest(`${network.origin}/api/ontos/cart`, {
      headers: { "x-akros-market-locale": "sk" },
    });
    try {
      expect(await request.run(() => getActiveMarket())).toMatchObject({
        marketId: "m-sk",
        currency: "EUR",
      });
    } finally {
      await request.close();
    }
    expect(reads).toHaveLength(2);
    expect(reads[1]?.query).toMatchObject({ view: { storefrontCatalog: { marketId: "m-sk" } } });
  });

  it.each([
    ["fr", 404],
    ["pl", 409],
  ])("preserves API refusal for locale %s without offer reads", async (locale, status) => {
    const { getActiveMarket } = await import("@/ontos/active-market");
    const request = nextRequest(`${network.origin}/api/ontos/cart`, {
      headers: { "x-akros-market-locale": locale },
    });
    try {
      await expect(request.run(() => getActiveMarket())).rejects.toMatchObject({ status });
    } finally {
      await request.close();
    }
    expect(reads).toHaveLength(1);
    expect(catalogReads()).toBe(1);
  });

  it("keeps the selected market when an optional offer is unavailable", async () => {
    beforeOffer = async (marketId) =>
      marketId === "m-eu"
        ? Response.json({ code: "offer_unavailable" }, { status: 503 })
        : undefined;
    const resolution = await market$.resolveStorefrontMarket("sk");
    expect(resolution).toMatchObject({
      kind: "live",
      market: { marketId: "m-sk", currency: "EUR" },
    });
    expect(resolution.live).toContainEqual({ locale: "en", marketCode: "AKROS-EU", label: "EN" });
  });

  it("starts the selected offer first and bounds lazy switcher offer work", async () => {
    const locales = ["cs", "sk", "en", "de", "fr", "hu", "it", "es"];
    const entries = market$.storefrontMarkets(
      {
        markets: locales.map((locale) => market(`m-${locale}`, `AKROS-${locale}`, [locale])),
        associations: locales.map((locale) => association(`m-${locale}`)),
      },
      NOW,
      AKROS_STOREFRONT,
    );
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const offers = new Map<string, Promise<MarketModule.MarketOffer>>();
    const operation: MarketModule.MarketReadOperation = {
      directory: async () => ({ entries, unmarketed: false }),
      offer: (id) => {
        const held = offers.get(id);
        if (held) return held;
        calls.push(id);
        const result = (async (): Promise<MarketModule.MarketOffer> => {
          if (id !== "m-sk") {
            active++;
            peak = Math.max(peak, active);
            if (active === 2) started.resolve();
            await release.promise;
            active--;
          }
          return { configured: true, currency: "EUR" };
        })();
        offers.set(id, result);
        return result;
      },
      check: () => {},
      dispose: () => {},
    };
    const pending = market$.resolveStorefrontMarket("sk", operation);
    try {
      await started.promise;
      expect(calls[0]).toBe("m-sk");
      expect(active).toBeLessThanOrEqual(2);
    } finally {
      release.resolve();
    }
    const result = await pending;
    expect(peak).toBeLessThanOrEqual(2);
    expect(calls).toHaveLength(locales.length);
    expect(result.live).toHaveLength(locales.length);
    expect(result.live.every(({ currency }) => currency === "EUR")).toBe(true);
  });

  it.each(["overloaded", "body_oversize"] as const)(
    "does not fail the selected market on an optional %s",
    async (kind) => {
      const { OperationError } = await import("@ontos/storefront-runtime");
      const operation = market$.createMarketReadOperation();
      await market$.resolveActiveStorefrontMarket("sk", operation);
      const offer = operation.offer;
      operation.offer = (id) =>
        id === "m-eu" ? Promise.reject(new OperationError(kind)) : offer(id);
      try {
        const result = await market$.resolveStorefrontMarket("sk", operation);
        expect(result).toMatchObject({
          kind: "live",
          market: { marketId: "m-sk", currency: "EUR" },
        });
        expect(result.live).toContainEqual({ locale: "en", marketCode: "AKROS-EU", label: "EN" });
      } finally {
        operation.dispose();
      }
    },
  );

  it.each(["cancelled", "deadline"] as const)(
    "propagates caller %s while optional offers are pending",
    async (kind) => {
      const { createOperation } = await import("@ontos/storefront-runtime");
      const lifetime = Effect.runSync(createOperation());
      const operation = market$.createMarketReadOperation({ operation: lifetime });
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      beforeOffer = async (id) => {
        if (id !== "m-sk") {
          started.resolve();
          await release.promise;
        }
        return undefined;
      };
      const pending = market$.resolveStorefrontMarket("sk", operation);
      const rejected = expect(pending).rejects.toMatchObject({ kind });
      try {
        await started.promise;
        lifetime.abort(kind);
        await rejected;
      } finally {
        release.resolve();
        lifetime.dispose();
      }
    },
  );

  it("retains a failed directory promise only within its operation", async () => {
    const operation = market$.createMarketReadOperation();
    failure = { status: 403, code: "denied" };
    const first = operation.directory();
    expect(operation.directory()).toBe(first);
    await expect(first).rejects.toMatchObject({ status: 403 });
    failure = undefined;
    await expect(operation.directory()).rejects.toMatchObject({ status: 403 });
    expect(catalogReads()).toBe(1);
    expect(await market$.resolveActiveStorefrontMarket("cs")).toMatchObject({ kind: "live" });
    expect(catalogReads()).toBe(2);
  });

  it("retains a failed selected offer promise within the operation, then reads fresh next time", async () => {
    const operation = market$.createMarketReadOperation();
    await operation.directory();
    failure = { status: 403, code: "offer-denied" };
    const first = operation.offer("m-sk");
    expect(operation.offer("m-sk")).toBe(first);
    await expect(first).rejects.toMatchObject({ status: 403 });
    failure = undefined;
    await expect(market$.resolveStorefrontMarket("sk", operation)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      reads.filter(
        ({ audience, query }) =>
          audience === "merchandise" &&
          Schema.decodeUnknownSync(OfferQuery)(query).view.storefrontCatalog.marketId === "m-sk",
      ),
    ).toHaveLength(1);
    expect(await market$.resolveActiveStorefrontMarket("sk")).toMatchObject({ kind: "live" });
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
  it("serves /cs as the Czech CZK catalogue without a market when the catalog is empty", async () => {
    catalogBody = { ...catalog, markets: [], associations: [] };
    expect(await market$.resolveStorefrontMarket("cs")).toEqual(unmarketed);
    expect(await market$.storefrontMarketKind("cs")).toBe("live");
    expect(await market$.storefrontMarketKind("sk")).toBe("unknown");
    expect(await market$.resolveStorefrontMarket("sk")).toMatchObject({
      kind: "unknown",
      live: unmarketed.live,
    });
    // No resolution and no merchandise read: nothing to resolve yet.
    await network.idle();
    expect(reads).toHaveLength(4);
  });

  it("ignores other sellers' markets and other storefronts' associations", async () => {
    catalogBody = {
      markets: [market("m-kav", "KAVARNA-CZ", ["cs"], { country: "CZ", legalEntity: KAVARNA })],
      associations: [association("m-kav", { appId: "kavarna-doma-eshop", legalEntity: KAVARNA })],
    };
    expect(await market$.resolveStorefrontMarket("cs")).toEqual(unmarketed);
  });

  it("keeps serving the owners' markets once one exists, even if none is live", async () => {
    catalogBody = {
      markets: [market("m-at", "AKROS-AT", ["de"], { lifecycle: "RETIRED" })],
      associations: [],
    };
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
  ])(
    "serves /cs without a market when %s, without retaining it across operations",
    async (_case, status, tag) => {
      failure = { status, code: "rejected", _tag: tag };
      expect(await market$.resolveStorefrontMarket("cs")).toEqual(unmarketed);
      await network.idle();
      // An audience rejection is definitive, not a transient read admission failure.
      expect(catalogReads()).toBe(1);
      expect(await market$.storefrontMarketKind("en")).toBe("unknown");
      await network.idle();
      expect(catalogReads()).toBe(2);
    },
  );

  it("reports a market owner outage instead of falling back", async () => {
    failure = { status: 503, code: "down" };
    await expect(market$.resolveStorefrontMarket("cs")).rejects.toMatchObject({
      status: 503,
      code: "down",
    });
    failure = { status: 400, code: "bad request", _tag: "OtherProblem" };
    await expect(market$.resolveStorefrontMarket("cs")).rejects.toMatchObject({
      status: 400,
      code: "bad request",
    });
  });
});
