import type { Operation } from "@ontos/storefront-runtime";
import { renderOperation } from "./render-operation";
import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { dictionaryFor } from "@/i18n";
import type { MoneyFormat } from "@/lib/format";
import { localeDictionary, RequestError } from "./http";
import {
  createMarketReadOperation,
  resolveActiveStorefrontMarket,
  resolveStorefrontMarket,
  type ActiveMarket,
  type MarketReadOperation,
  type MarketResolution,
} from "./market";
import type { ClientMarket } from "./market-context";
import { localizeHref, MARKET_LOCALE_HEADER, STORE_PATH_HEADER } from "./market-locale";

/**
 * The market of this request. Pages get the locale header from the proxy (derived from the path, any
 * browser value is overwritten); API routes get it from the browser and it only selects a market that the
 * owners resolve here. One resolution per server render.
 */
// API handlers do not have React's render cache. Key promises by the explicit lifetime in both contexts.
const marketReads = new WeakMap<Operation, MarketReadOperation>();
export const marketReadsFor = (operation: Operation): MarketReadOperation => {
  const held = marketReads.get(operation);
  if (held) return held;
  const reads = createMarketReadOperation({ operation });
  marketReads.set(operation, reads);
  return reads;
};
export const getMarketResolution = cache(
  async (): Promise<MarketResolution> =>
    await resolveStorefrontMarket(
      (await headers()).get(MARKET_LOCALE_HEADER) ?? "",
      marketReadsFor(renderOperation()),
    ),
);

/** The live market of this request; an unknown, missing or inactive market is refused (4xx). */
export async function getActiveMarket(
  operation: MarketReadOperation = marketReadsFor(renderOperation()),
): Promise<ActiveMarket> {
  const resolution = await resolveActiveStorefrontMarket(
    (await headers()).get(MARKET_LOCALE_HEADER) ?? "",
    operation,
  );
  if (resolution.kind === "live") return resolution.market;
  const t = localeDictionary((await headers()).get(MARKET_LOCALE_HEADER));
  if (resolution.kind === "unknown") throw new RequestError(404, t.server.market.unknown);
  throw new RequestError(409, t.server.market.unavailable);
}

/** Currency and locale of the request market's prices (server components). */
export async function getMoney(): Promise<MoneyFormat> {
  const market = await getActiveMarket();
  return { currency: market.currency, locale: market.formatLocale };
}

/** Storefront path of this page request without the locale (set by the proxy). */
export const getStorePath = async () => (await headers()).get(STORE_PATH_HEADER) ?? "/";

/** Server-side internal href of the active market (`redirect(await marketHref("/prihlaseni"))`). */
export async function marketHref(href: string): Promise<string> {
  return localizeHref(href, (await headers()).get(MARKET_LOCALE_HEADER) ?? undefined);
}

/** UI chrome strings of the request's market locale. */
export async function getDictionary() {
  return dictionaryFor((await headers()).get(MARKET_LOCALE_HEADER) ?? undefined);
}

export const toClientMarket = (
  resolution: Extract<MarketResolution, { kind: "live" }>,
): ClientMarket => ({
  locale: resolution.market.locale,
  marketCode: resolution.market.marketCode,
  currency: resolution.market.currency,
  formatLocale: resolution.market.formatLocale,
  configured: resolution.market.configured,
  live: resolution.live,
});
