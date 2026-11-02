import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { dictionaryFor } from "@/i18n";
import type { MoneyFormat } from "@/lib/format";
import { RequestError } from "./http";
import { resolveStorefrontMarket, type ActiveMarket, type MarketResolution } from "./market";
import type { ClientMarket } from "./market-context";
import { localizeHref, MARKET_LOCALE_HEADER, STORE_PATH_HEADER } from "./market-locale";

/**
 * The market of this request. Pages get the locale header from the proxy (derived from the path, any
 * browser value is overwritten); API routes get it from the browser and it only selects a market that the
 * owners resolve here. One resolution per server render.
 */
export const getMarketResolution = cache(
  async (): Promise<MarketResolution> =>
    await resolveStorefrontMarket((await headers()).get(MARKET_LOCALE_HEADER) ?? ""),
);

/** The live market of this request; an unknown, missing or inactive market is refused (4xx). */
export async function getActiveMarket(): Promise<ActiveMarket> {
  const resolution = await getMarketResolution();
  if (resolution.kind === "unknown") throw new RequestError(404, "Tento trh neexistuje.");
  if (resolution.kind === "not-active")
    throw new RequestError(409, "Tento trh je dočasně nedostupný.");
  return resolution.market;
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
