// @rstest-environment happy-dom
import { browserNetwork, networkIdle } from "@app/shared-contracts/testing/http-double";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-rstest";
import type { getCatalog } from "../src/ontos/catalog";
import type { CatalogResponseSchema } from "../src/ontos/catalog-model";
import { projectCatalog } from "../src/ontos/catalog-model";
import { readCardVariants } from "../src/ontos/card-variants-server";
import { CardVariantsQuerySchema } from "../src/ontos/card-variants";
import { GET } from "../src/app/api/card-variants/route";

const query = { locale: "cs", productId: "owner-product", slug: "owner-product" } as const;
const ownerCatalog = {
  market: { configured: true, currency: "CZK", marketId: "N1-CZ" },
  products: [
    {
      id: query.productId,
      name: "Owner product",
      slug: query.slug,
      variantRecords: [
        {
          active: true,
          attributes: "",
          availability: "IN_STOCK",
          grossPriceMinor: 100,
          id: "first",
          name: "XL",
          sku: "XL",
          stockOnHand: 2,
        },
        {
          active: false,
          attributes: "",
          availability: "IN_STOCK",
          grossPriceMinor: 100,
          id: "removed",
          name: "OLD",
          sku: "OLD",
          stockOnHand: 2,
        },
        {
          active: true,
          attributes: "",
          availability: "IN_STOCK",
          grossPriceMinor: 100,
          id: "second",
          name: "SM",
          sku: "SM",
          stockOnHand: 2,
        },
      ],
    },
  ],
} satisfies typeof CatalogResponseSchema.Type;
const catalog = projectCatalog(ownerCatalog, []);
const readReadyCatalog: typeof getCatalog = async () => ({ catalog, state: "ready" });
const readWithoutNames: typeof getCatalog = async () => ({
  catalog: {
    ...catalog,
    details: catalog.details.map((product) => ({
      ...product,
      variantCount: 8,
      variants: [],
    })),
  },
  state: "ready",
});

const marketId = "72000000-0000-4000-8000-000000000099";
const GatewayRead = Schema.Struct({
  query: Schema.Struct({
    view: Schema.optionalKey(
      Schema.Struct({
        storefrontCatalog: Schema.Struct({
          fields: Schema.String,
          includeCategories: Schema.Boolean,
          marketId: Schema.String,
          pageSize: Schema.Int,
          slug: Schema.String,
        }),
      }),
    ),
  }),
  readName: Schema.String,
});

describe("card variant intent read", () => {
  it.live("uses one exact full slug query and returns only real active names in owner order", () =>
    Effect.gen(function* readSingleSlug() {
      const reads: Parameters<typeof getCatalog>[] = [];
      const read: typeof getCatalog = async (...args) => {
        reads.push(args);
        return { catalog, state: "ready" };
      };
      expect(yield* readCardVariants(query, read)).toEqual({
        productId: query.productId,
        slug: query.slug,
        state: "ready",
        variants: [
          { id: "first", name: "XL" },
          { id: "second", name: "SM" },
        ],
      });
      yield* networkIdle;
      expect(reads).toEqual([["cs", JSON.stringify({ slug: query.slug })]]);
    }),
  );
  it.effect("does not substitute another product returned by the owner", () =>
    Effect.gen(function* rejectWrongProduct() {
      expect(
        yield* readCardVariants({ ...query, productId: "other-product" }, readReadyCatalog),
      ).toEqual({
        state: "unavailable",
      });
      expect(yield* readCardVariants({ ...query, slug: "other-slug" }, readReadyCatalog)).toEqual({
        state: "unavailable",
      });
    }),
  );
  it.effect("does not invent missing names from variant count or card previews", () =>
    Effect.gen(function* keepMissingNames() {
      expect(yield* readCardVariants(query, readWithoutNames)).toEqual({
        productId: query.productId,
        slug: query.slug,
        state: "ready",
        variants: [],
      });
    }),
  );
  it.effect("retains unavailable reads and unconfigured markets without a fabricated list", () =>
    Effect.gen(function* keepUnavailable() {
      expect(
        yield* readCardVariants(query, async () => ({
          reason: "StorefrontReadUnavailable",
          state: "unavailable",
        })),
      ).toEqual({ state: "unavailable" });
      expect(
        yield* readCardVariants(query, async () => ({
          catalog: { ...catalog, configured: false },
          state: "ready",
        })),
      ).toEqual({ state: "unavailable" });
    }),
  );
  it("rejects invalid locale and unbounded identifiers", () => {
    const valid = Schema.is(CardVariantsQuerySchema);
    expect(valid(query)).toBe(true);
    expect(valid({ ...query, locale: "invalid" })).toBe(false);
    expect(valid({ ...query, slug: "" })).toBe(false);
    expect(valid({ ...query, productId: "x".repeat(301) })).toBe(false);
  });
  it.live("serves a no-store typed GET and rejects bad input before owner access", () =>
    Effect.gen(function* serveCardVariants() {
      const config = {
        ONTOS_N1_STOREFRONT_API_KEY: "card-variants-test-service-key",
        ONTOS_SHELL_URL: "https://shell.example",
        ONTOS_STOREFRONT_LEGAL_ENTITY_ID: "71000000-0000-4000-8000-000000000099",
        ONTOS_STOREFRONT_TENANT_ID: "70000000-0000-4000-8000-000000000099",
      };
      const previous = Object.keys(config).map((key) => [key, process.env[key]] as const);
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          for (const [key, value] of Object.entries(config)) {
            process.env[key] = value;
          }
        }),
        () =>
          Effect.sync(() => {
            for (const [key, value] of previous) {
              if (value === undefined) {
                Reflect.deleteProperty(process.env, key);
              } else {
                process.env[key] = value;
              }
            }
          }),
      );
      const reads: (typeof GatewayRead.Type)[] = [];
      const owner = HttpRouter.add(
        "POST",
        "/shell-super-app-api/auth/api-key/gateway-read",
        Effect.gen(function* answerGatewayRead() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const read = yield* request.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(GatewayRead)),
          );
          reads.push(read);
          const headers = {
            "x-ontos-gateway-context": JSON.stringify({
              apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
              compositionRevision: "a".repeat(64),
              expiresAt: 9_999_999_999,
              token: "card-variants-test-read-assertion",
            }),
          };
          if (read.readName === "current-market-catalog") {
            return HttpServerResponse.jsonUnsafe(
              {
                associations: [
                  {
                    channel: "B2C",
                    effectivePeriod: { startsAt: "2020-01-01T00:00:00Z" },
                    marketRef: { resourceId: marketId },
                    sellingLegalEntityRef: { resourceId: config.ONTOS_STOREFRONT_LEGAL_ENTITY_ID },
                    storefrontRef: {
                      appId: "n1-storefront",
                      tenantId: config.ONTOS_STOREFRONT_TENANT_ID,
                    },
                  },
                ],
                markets: [
                  {
                    effectivePeriod: { startsAt: "2020-01-01T00:00:00Z" },
                    lifecycle: "ACTIVE",
                    marketCode: "N1",
                    marketRef: { resourceId: marketId },
                    sellingLegalEntityRef: { resourceId: config.ONTOS_STOREFRONT_LEGAL_ENTITY_ID },
                    supportedLocales: ["cs-CZ", "en-GB"],
                  },
                ],
              },
              { headers },
            );
          }
          expect(read.readName).toBe("records");
          return HttpServerResponse.jsonUnsafe(
            {
              ...ownerCatalog,
              market: { ...ownerCatalog.market, marketId },
            },
            { headers },
          );
        }).pipe(Effect.orDie),
      );
      yield* Effect.gen(function* requestCardVariants() {
        const response = yield* Effect.promise(() =>
          GET(new Request(`https://n1.example/api/card-variants?${new URLSearchParams(query)}`)),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.promise(() => response.json())).toEqual({
          productId: query.productId,
          slug: query.slug,
          state: "ready",
          variants: [
            { id: "first", name: "XL" },
            { id: "second", name: "SM" },
          ],
        });
        yield* networkIdle;
        expect(reads.map((read) => read.readName)).toEqual(["current-market-catalog", "records"]);
        expect(reads[1]?.query.view?.storefrontCatalog).toEqual({
          fields: "full",
          includeCategories: true,
          marketId,
          pageSize: 1,
          slug: query.slug,
        });
        reads.length = 0;
        const invalid = yield* Effect.promise(() =>
          GET(new Request("https://n1.example/api/card-variants?locale=bad&slug=x&productId=x")),
        );
        expect(invalid.status).toBe(400);
        yield* networkIdle;
        expect(reads).toEqual([]);
      }).pipe(Effect.provide(browserNetwork(owner)));
    }).pipe(Effect.scoped),
  );
});
