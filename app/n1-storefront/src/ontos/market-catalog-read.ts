import "server-only";
import { cache } from "react";
import { Clock, Effect, Fiber } from "effect";
import type { HttpClient } from "effect/http";
import type { StorefrontConfiguration } from "./config";
import { readOwner } from "./gateway";
import type { StorefrontReadUnavailable } from "./gateway";
import { MarketCatalogSchema } from "./market";

type MarketCatalog = typeof MarketCatalogSchema.Type;
type SharedMarketCatalogRead = Fiber.Fiber<
  { readonly markets: MarketCatalog; readonly now: number },
  StorefrontReadUnavailable
>;

/**
 * React keeps one holder per server render, so the layout's catalogue and cart-scope chains share one read. Outside a
 * render (route handlers, server actions) `cache()` memoizes nothing and every call gets a fresh holder. Nothing
 * outlives the request: prices and the active market are never served stale, and a failure never reaches a later one.
 */
const requestReads = cache(() => new Map<string, SharedMarketCatalogRead>());

const readMarketCatalog = (config: StorefrontConfiguration) =>
  Effect.gen(function* readMarketCatalogProgram() {
    const now = yield* Clock.currentTimeMillis;
    const markets = yield* readOwner(
      config,
      "commerce-market-catalog",
      "current-market-catalog",
      { at: new Date(now).toISOString() },
      MarketCatalogSchema,
    );
    return { markets, now };
  });

/**
 * The current market catalogue and the instant it was read at, once per request. Every caller joins the same read
 * (with its own retries), so all of them see the same success or the same failure.
 */
export const readCurrentMarketCatalog = (config: StorefrontConfiguration) =>
  Effect.gen(function* readCurrentMarketCatalogProgram() {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    const reads = requestReads();
    const key = JSON.stringify([config.shellUrl, config.apiKey, config.legalEntityId]);
    // Look up and start in one synchronous step, so two concurrent chains can never both start a read.
    const read = yield* Effect.sync(() => {
      const existing = reads.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const started = Effect.runForkWith(context)(readMarketCatalog(config));
      reads.set(key, started);
      return started;
    });
    return yield* Fiber.join(read);
  });
