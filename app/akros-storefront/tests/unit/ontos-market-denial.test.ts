import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import type * as MarketModule from "@/ontos/market";
import { browserAt, serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

// Regression: a denied commerce.market-catalog read must not be mistaken for proof of a pre-market
// installation. The unrestricted /cs catalogue (no marketId, so no assortment filter in
// catalog-server.readCatalog) is only legitimate when the owner proves emptiness — a 200 with no
// markets and no associations — or when the module is not part of the approved Application
// Composition at all (400 GatewayAudienceInvalidProblem; see
// apps/shell-super-app/api/auth/gateway-issuer.ts). A 403/404 from the composed owner means markets
// may exist and be restricted: the storefront must surface the denial, never widen the catalogue.

const AKROS = "71000000-0000-4000-8000-000000000024";
const identity = { appId: "akros-storefront", legalEntityId: AKROS };
const TENANT = "70000000-0000-4000-8000-000000000020";
const MARKET = "m-cz";
const NOW = Date.parse("2026-11-04T10:00:00Z");
const gatewayRead = Schema.Struct({
  audience: Schema.String,
  legalEntityId: Schema.Literal(AKROS),
  readName: Schema.String,
  query: Schema.Unknown,
});
const decodeRead = Schema.decodeUnknownSync(gatewayRead);
const emptyCatalog = {
  markets: [],
  associations: [],
  completenessEvidence: {},
  observedAt: "2026-11-04T10:00:00Z",
};

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
let network: Awaited<ReturnType<typeof serveHttp>>;
let request: ReturnType<typeof nextRequest>;
let ownerResponse: { body: unknown; status: number };
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  ownerResponse = { body: emptyCatalog, status: 200 };
  network = await serveHttp(async (incoming) => {
    if (
      incoming.method !== "POST" ||
      new URL(incoming.url).pathname !== "/shell-super-app-api/auth/api-key/gateway-read" ||
      incoming.headers.get("x-api-key") !== "test"
    )
      return Response.json({ error: "unexpected gateway request" }, { status: 404 });
    const read = decodeRead(await incoming.json());
    const headers = {
      "x-ontos-gateway-context": JSON.stringify({
        apiBaseUrl: `/shell-super-app-api/${read.audience}`,
        compositionRevision: "a".repeat(64),
        token: "served-read-assertion",
        expiresAt: NOW + 300_000,
      }),
    };
    if (read.audience === "commerce-market-catalog" && read.readName === "current-market-catalog")
      return Response.json(ownerResponse.body, { status: ownerResponse.status, headers });
    if (read.audience === "merchandise" && read.readName === "records")
      return Response.json(offer, { headers });
    return Response.json({ error: "unexpected owner read" }, { status: 404 });
  });
  browserAt(network.origin);
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "test");
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", identity.appId);
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", identity.legalEntityId);
  request = nextRequest(`${network.origin}/cs`);
  market$ = await import("@/ontos/market");
});
afterEach(async () => {
  try {
    await request.close();
  } finally {
    await network.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

const ownerReads = async () => {
  await network.idle();
  return Promise.all(
    network.requests.map(async (incoming) => {
      const { audience, readName } = decodeRead(await incoming.json());
      return `${audience}/${readName}`;
    }),
  );
};

describe("legitimate pre-market installation", () => {
  it("serves /cs without a marketId only when the owner proves the catalogue is empty", async () => {
    expect(await request.run(() => market$.resolveStorefrontMarket("cs"))).toEqual(unmarketed);
    expect(await request.run(() => market$.storefrontMarketKind("cs"))).toBe("live");
    expect(await request.run(() => market$.storefrontMarketKind("sk"))).toBe("unknown");
    // Nothing to scope: no catalogue read is attempted, let alone one without a marketId.
    expect(await ownerReads()).toEqual(["commerce-market-catalog/current-market-catalog"]);
  });

  it("keeps /cs when the market module is not part of the approved composition", async () => {
    ownerResponse = { body: { _tag: "GatewayAudienceInvalidProblem" }, status: 400 };
    expect(await request.run(() => market$.resolveStorefrontMarket("cs"))).toEqual(unmarketed);
    expect(await request.run(() => market$.storefrontMarketKind("sk"))).toBe("unknown");
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
      ownerResponse = { body: { _tag: tag }, status };
      await expect(request.run(() => market$.resolveStorefrontMarket("cs"))).rejects.toMatchObject({
        status,
      });
      await expect(request.run(() => market$.storefrontMarketKind("cs"))).rejects.toMatchObject({
        status,
      });
    },
  );

  it("refuses /cs when a denied read hides the markets the storefront already had", async () => {
    // The owner confirmed one active CZ market: every catalogue read is scoped by its marketId.
    ownerResponse = { body: catalog, status: 200 };
    const first = await request.run(() => market$.resolveStorefrontMarket("cs"));
    expect(first.kind === "live" && first.market.marketId).toBe(MARKET);
    await network.idle();
    const merchandiseReads = await Promise.all(
      network.requests.map(async (incoming) => decodeRead(await incoming.json())),
    );
    expect(merchandiseReads.filter((read) => read.audience === "merchandise")).toEqual([
      {
        audience: "merchandise",
        legalEntityId: AKROS,
        readName: "records",
        query: {
          view: {
            storefront: true,
            storefrontCatalog: {
              marketId: MARKET,
              pageSize: 1,
              fields: "card",
              includeCategories: false,
            },
          },
        },
      },
    ]);

    // Access is revoked. After the 60 s directory cache expires, /cs must not silently answer with
    // the whole published catalogue because the denial cannot prove the market is gone.
    ownerResponse = { body: { _tag: "CurrentMarketCatalogForbiddenProblem" }, status: 403 };
    vi.setSystemTime(NOW + 61_000);
    await expect(request.run(() => market$.resolveStorefrontMarket("cs"))).rejects.toMatchObject({
      status: 403,
    });
  });
});
