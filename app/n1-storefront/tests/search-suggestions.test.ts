import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@modern-js/bff-effect/effect-edge";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-rstest";
import type { getCatalog } from "../src/ontos/catalog";
import type { CatalogResponseSchema } from "../src/ontos/catalog-model";
import { projectCatalog } from "../src/ontos/catalog-model";
import { readSearchSuggestions } from "../src/ontos/search-suggestions";
import { SearchSuggestionsResponse } from "../src/ontos/search-contract";
import { GET } from "../src/app/api/search-suggestions/route";
import { ownerServer } from "./support/owner-server";

const tenantId = "70000000-0000-4000-8000-000000000099";
const legalEntityId = "71000000-0000-4000-8000-000000000099";
const marketId = "72000000-0000-4000-8000-000000000099";
const ownerCatalog: typeof CatalogResponseSchema.Type = {
  market: { configured: true, currency: "CZK", marketId },
  products: Array.from({ length: 10 }, (_, index) => ({
    id: `owner-${index}`,
    name: `Owner product ${index}`,
    slug: `owner-${index}`,
  })),
};
const catalog = projectCatalog(ownerCatalog, []);
const empty: typeof getCatalog = async () => ({
  catalog: { ...catalog, products: [] },
  state: "ready",
});
const unavailable: typeof getCatalog = async () => ({
  reason: "StorefrontReadUnavailable",
  state: "unavailable",
});
const unconfigured: typeof getCatalog = async () => ({
  catalog: { ...catalog, configured: false },
  state: "ready",
});

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
      marketCode: "N1",
      marketRef: { resourceId: marketId },
      sellingLegalEntityRef: { resourceId: legalEntityId },
      supportedLocales: ["cs-CZ", "en-GB"],
    },
  ],
};
const OwnerRequest = Schema.Struct({
  audience: Schema.String,
  legalEntityId: Schema.String,
  query: Schema.Unknown,
  readName: Schema.String,
});

const getPreview = (url: string) =>
  Effect.gen(function* previewRequest() {
    const requests: (typeof OwnerRequest.Type)[] = [];
    const owner = HttpRouter.add(
      "POST",
      "/shell-super-app-api/auth/api-key/gateway-read",
      Effect.gen(function* receiveOwnerRead() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* Schema.decodeUnknownEffect(OwnerRequest)(yield* request.json);
        requests.push(body);
        return HttpServerResponse.jsonUnsafe(
          body.readName === "current-market-catalog" ? marketCatalog : ownerCatalog,
          {
            headers: {
              "x-ontos-gateway-context": JSON.stringify({
                apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
                compositionRevision: "a".repeat(64),
                expiresAt: 9_999_999_999,
                token: "search-suggestions-read-assertion",
              }),
            },
          },
        );
      }).pipe(Effect.orDie),
    );
    const environment = {
      ONTOS_N1_STOREFRONT_API_KEY: "search-suggestions-service-key",
      ONTOS_STOREFRONT_LEGAL_ENTITY_ID: legalEntityId,
      ONTOS_STOREFRONT_TENANT_ID: tenantId,
    };
    return yield* Effect.gen(function* readPreview() {
      const response = yield* Effect.promise(async () => await GET(new Request(url)));
      const body: unknown = yield* Effect.promise(async () => await response.json());
      return { body, requests, response };
    }).pipe(Effect.provide(ownerServer(owner, environment)));
  });

describe("search suggestions read boundary", () => {
  it("does not call the owner for a blank query", async () => {
    const reads: Parameters<typeof getCatalog>[] = [];
    const read: typeof getCatalog = async (...args) => {
      reads.push(args);
      return { catalog, state: "ready" };
    };
    expect(await readSearchSuggestions("cs", "   ", read)).toEqual({ state: "idle" });
    expect(reads).toEqual([]);
  });

  it.each([
    ["invalid", "helmet"],
    ["cs", "x".repeat(201)],
  ])("rejects invalid locale or unbounded query before owner access: %s", async (locale, query) => {
    const reads: Parameters<typeof getCatalog>[] = [];
    const read: typeof getCatalog = async (...args) => {
      reads.push(args);
      return { catalog, state: "ready" };
    };
    expect(await readSearchSuggestions(locale, query, read)).toEqual({ state: "unavailable" });
    expect(reads).toEqual([]);
  });

  it("uses the same owner query as the results page and bounds only the preview", async () => {
    const reads: Parameters<typeof getCatalog>[] = [];
    const read: typeof getCatalog = async (...args) => {
      reads.push(args);
      return { catalog, state: "ready" };
    };
    expect(await readSearchSuggestions("cs", "  helmet  ", read)).toEqual({
      products: catalog.products.slice(0, 8),
      state: "ready",
    });
    expect(reads).toEqual([["cs", JSON.stringify({ q: "helmet" })]]);
  });

  it("keeps a successful empty catalogue distinct from an unavailable read", async () => {
    expect(await readSearchSuggestions("cs", "absent", empty)).toEqual({
      products: [],
      state: "ready",
    });
    expect(await readSearchSuggestions("cs", "helmet", unavailable)).toEqual({
      state: "unavailable",
    });
  });

  it("does not present an unconfigured market as a successful empty result", async () => {
    expect(await readSearchSuggestions("en", "helmet", unconfigured)).toEqual({
      state: "unavailable",
    });
  });

  it.live("serves an uncached GET preview through the existing owner query", () =>
    Effect.gen(function* verifyPreview() {
      const { body, requests, response } = yield* getPreview(
        "https://shop.example/api/search-suggestions?locale=cs&q=helmet",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({
        products: catalog.products.slice(0, 8),
        state: "ready",
      });
      expect(requests).toEqual([
        {
          audience: "commerce-market-catalog",
          legalEntityId,
          query: { at: expect.any(String) },
          readName: "current-market-catalog",
        },
        {
          audience: "merchandise",
          legalEntityId,
          query: {
            view: {
              storefront: true,
              storefrontCatalog: {
                fields: "card",
                includeCategories: true,
                marketId,
                pageSize: 24,
                q: "helmet",
                storefrontAppId: "n1-storefront",
              },
            },
          },
          readName: "records",
        },
      ]);
    }),
  );

  it.live("rejects an invalid GET locale without accessing owner data", () =>
    Effect.gen(function* verifyPreview() {
      const { body, requests } = yield* getPreview(
        "https://shop.example/api/search-suggestions?locale=invalid&q=helmet",
      );
      expect(body).toEqual({ state: "unavailable" });
      expect(requests).toEqual([]);
    }),
  );

  it("rejects oversized or unknown transport results while accepting a real empty result", () => {
    const valid = Schema.is(SearchSuggestionsResponse);
    expect(valid({ products: [], state: "ready" })).toBe(true);
    expect(valid({ products: catalog.products, state: "ready" })).toBe(false);
    expect(valid({ state: "unexpected" })).toBe(false);
  });
});
