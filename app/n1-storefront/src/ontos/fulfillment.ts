import "server-only";
import { cache } from "react";
import { Clock, Effect, Schema } from "effect";
import { readConfiguration } from "./config";
import type { StorefrontConfiguration } from "./config";
import { readOwner } from "./gateway";
import { MarketCatalogSchema, selectMarket } from "./market";
import { FulfillmentSnapshotSchema, projectFulfillment } from "./fulfillment-model";
import type { FulfillmentResult } from "./fulfillment-model";
import { storefrontRuntime } from "./runtime";

export const readFulfillment = (config: StorefrontConfiguration, locale: string) =>
  Effect.gen(function* readFulfillmentProgram() {
    yield* Schema.decodeUnknownEffect(Schema.Literals(["cs", "en"]))(locale);
    const now = yield* Clock.currentTimeMillis;
    const catalog = yield* readOwner(
      config,
      "commerce-market-catalog",
      "current-market-catalog",
      { at: new Date(now).toISOString() },
      MarketCatalogSchema,
    );
    const market = yield* selectMarket(catalog, config, locale, now);
    const snapshot = yield* readOwner(
      config,
      "merchandise",
      "records",
      {
        view: {
          storefront: true,
          storefrontCatalog: {
            includeCategories: false,
            marketId: market.marketRef.resourceId,
            mode: "categories",
          },
          storefrontCheckout: true,
        },
      },
      FulfillmentSnapshotSchema,
    );
    return yield* projectFulfillment(snapshot, market.marketRef.resourceId);
  });

/** Request-local SSR cache only. No unfiltered catalog or fixture tariff fallback. */
export const getFulfillment = cache(
  async (locale: string): Promise<FulfillmentResult> =>
    await storefrontRuntime.runPromise(
      readConfiguration(process.env).pipe(
        Effect.flatMap((config) => readFulfillment(config, locale)),
        Effect.match({
          onFailure: () => ({ state: "unavailable" as const }),
          onSuccess: (info) => ({ info, state: "ready" as const }),
        }),
      ),
    ),
);
