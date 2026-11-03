import "server-only";
import { cache } from "react";
import { Clock, Effect, Schema } from "effect";
import { readConfiguration } from "./config";
import { readOwner, StorefrontReadUnavailable } from "./gateway";
import { MarketCatalogSchema, selectMarket } from "./market";
import { CatalogResponseSchema, projectCatalog } from "./catalog-model";
import { storefrontRuntime } from "./runtime";

export interface CatalogQuery {
  categorySlug?: string;
  featured?: boolean;
  page?: number;
  q?: string;
  slug?: string;
}

const CatalogQuerySchema = Schema.Struct({
  categorySlug: Schema.optionalKey(Schema.String),
  featured: Schema.optionalKey(Schema.Boolean),
  page: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  q: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  slug: Schema.optionalKey(Schema.String),
});

/** Read-only public channel. No writes, seed catalog or alternate data source lives in this app. */
export const loadCatalog = (locale: string, query: CatalogQuery) =>
  Effect.gen(function* loadCatalogProgram() {
    const config = yield* readConfiguration(process.env);
    const now = yield* Clock.currentTimeMillis;
    const markets = yield* readOwner(
      config,
      "commerce-market-catalog",
      "current-market-catalog",
      { at: new Date(now).toISOString() },
      MarketCatalogSchema,
    );
    const market = yield* selectMarket(markets, config, locale, now);
    const body = yield* readOwner(
      config,
      "merchandise",
      "records",
      {
        view: {
          storefront: true,
          storefrontCatalog: {
            ...query,
            fields: query.slug === undefined ? "card" : "full",
            includeCategories: true,
            marketId: market.marketRef.resourceId,
            pageSize: query.slug === undefined ? 24 : 1,
          },
        },
      },
      CatalogResponseSchema,
    );
    if (body.market.marketId !== market.marketRef.resourceId) {
      return yield* new StorefrontReadUnavailable({ reason: "contract" });
    }
    const hosts = (process.env.STOREFRONT_IMAGE_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    return projectCatalog(body, hosts);
  });

/** Framework edge: retain typed failures until they become an explicit page state. Request-local cache only. */
export const getCatalog = cache(
  async (locale: string, queryKey: string) =>
    await storefrontRuntime.runPromise(
      Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogQuerySchema))(queryKey).pipe(
        Effect.flatMap((query) => loadCatalog(locale, query)),
        Effect.tapError((error) =>
          Effect.logWarning("N1 catalog read unavailable").pipe(
            Effect.annotateLogs(
              error._tag === "StorefrontReadUnavailable"
                ? { failure: error._tag, reason: error.reason, status: error.status ?? 0 }
                : { failure: error._tag },
            ),
          ),
        ),
        Effect.match({
          onFailure: (error) => ({ reason: error._tag, state: "unavailable" as const }),
          onSuccess: (catalog) => ({ catalog, state: "ready" as const }),
        }),
      ),
    ),
);
