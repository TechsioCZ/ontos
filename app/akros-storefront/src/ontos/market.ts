import "server-only";
// Storefront market resolution (owner: commerce.market-catalog; offer/currency: merchandise).
//   1. `current-market-catalog {at}` (cached 60 s): associations of this storefront, channel B2C, effective now,
//      sold by the pinned AKROS legal entity → the market whose primary locale (supportedLocales[0]) is the path.
//   2. `resolve-commerce-market` with that explicit selection decides: MARKET_RESOLVED = live market,
//      MARKET_NOT_ACTIVE = „dočasně nedostupný“, anything not associated = unknown (404).
//   3. merchandise `storefrontCatalog {marketId}` returns the market's currency and whether its offer is configured.
// Before any market exists (no market of this seller, no association of this storefront, or the market owner not
// active/granted for this storefront yet), `/cs` serves the Czech CZK catalogue without a market filter; every other
// locale is unknown. As soon as one market or association exists, only the owners' markets are served.
// The path locale is only a selector: nothing a browser sends is used before the owners confirmed it.
import { getConfig } from "./config";
import { OntosError, readRecords } from "./gateway";
import { isLocaleSegment } from "./market-locale";
import { isStoreCurrency, type StoreCurrency } from "@/lib/format";

export const STOREFRONT_APP_ID = "akros-storefront";
const MARKET_CATALOG_AUDIENCE = "commerce-market-catalog";
const CHANNEL = "B2C";
export const MARKET_CACHE_MS = 60_000;

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const rows = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRaw) : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** One market this storefront is associated with (B2C, effective now), as the market catalog describes it. */
export interface StorefrontMarketEntry {
  marketId: string;
  marketCode: string;
  /** Path segment: language subtag of the primary locale (`cs`, `sk`, `en`, `de`). */
  locale: string;
  /** The market's primary locale for formatting (`cs`, `en-GB`, …). */
  formatLocale: string;
  lifecycle: "ACTIVE" | "SUSPENDED";
  /** Effective now by the market's own validity (the association is always effective now). */
  marketEffective: boolean;
  /** Switcher label: the single country jurisdiction (`CZ`) or the locale (`EN`). */
  label: string;
  tenantId: string;
  marketRef: Raw;
  sellingLegalEntityRef: Raw;
}

/** A market a customer can open now (switcher, hreflang, 404 / unavailable pages). */
export interface LiveMarket {
  locale: string;
  marketCode: string;
  label: string;
  currency?: StoreCurrency;
}

/** The resolved market of one request. */
export interface ActiveMarket {
  /** Absent only before any market exists: catalog reads, quotes and orders then carry no `marketId` (CZK). */
  marketId?: string;
  marketCode: string;
  locale: string;
  formatLocale: string;
  currency: StoreCurrency;
  /** false: merchandise has no offer for this market yet (no products are sold). */
  configured: boolean;
}

export type MarketResolution =
  | { kind: "live"; market: ActiveMarket; live: LiveMarket[] }
  | { kind: "not-active"; locale: string; marketCode: string; live: LiveMarket[] }
  | { kind: "unknown"; locale: string; live: LiveMarket[] };

const effectiveAt = (period: unknown, now: number): boolean => {
  if (!isRaw(period)) return false;
  const startsAt = Date.parse(text(period.startsAt));
  const endsAt =
    period.endsAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(text(period.endsAt));
  return Number.isFinite(startsAt) && startsAt <= now && now < endsAt;
};

const labelOf = (market: Raw, locale: string): string => {
  const countries = rows(market.jurisdictions).filter((entry) => entry.kind === "COUNTRY");
  return countries.length === 1 && text(countries[0].code)
    ? text(countries[0].code).toUpperCase()
    : locale.toUpperCase();
};

/**
 * Markets of this storefront from a `current-market-catalog` response: active associations of
 * `akros-storefront`, channel B2C, effective at `now`, sold by `legalEntityId`; retired markets are excluded.
 * Two markets with the same path locale: an ACTIVE one wins, then the lower market code.
 */
export function storefrontMarkets(
  catalog: unknown,
  now: number,
  legalEntityId: string,
): StorefrontMarketEntry[] {
  const body = isRaw(catalog) ? catalog : {};
  const markets = new Map(
    rows(body.markets).flatMap((market) =>
      isRaw(market.marketRef) && text(market.marketRef.resourceId)
        ? [[text(market.marketRef.resourceId), market] as const]
        : [],
    ),
  );
  const byLocale = new Map<string, StorefrontMarketEntry>();
  for (const association of rows(body.associations)) {
    const storefront = isRaw(association.storefrontRef) ? association.storefrontRef : {};
    const seller = isRaw(association.sellingLegalEntityRef)
      ? association.sellingLegalEntityRef
      : {};
    const marketRef = isRaw(association.marketRef) ? association.marketRef : {};
    const market = markets.get(text(marketRef.resourceId));
    if (
      market === undefined ||
      text(storefront.appId) !== STOREFRONT_APP_ID ||
      association.channel !== CHANNEL ||
      text(seller.resourceId) !== legalEntityId ||
      !effectiveAt(association.effectivePeriod, now) ||
      (market.lifecycle !== "ACTIVE" && market.lifecycle !== "SUSPENDED") ||
      !isRaw(market.sellingLegalEntityRef) ||
      !isRaw(market.marketRef)
    )
      continue;
    const formatLocale = text(
      Array.isArray(market.supportedLocales) ? market.supportedLocales[0] : undefined,
    );
    const locale = formatLocale.split("-")[0];
    if (!isLocaleSegment(locale)) continue;
    const entry: StorefrontMarketEntry = {
      marketId: text(marketRef.resourceId),
      marketCode: text(market.marketCode),
      locale,
      formatLocale,
      lifecycle: market.lifecycle,
      marketEffective: effectiveAt(market.effectivePeriod, now),
      label: labelOf(market, locale),
      tenantId: text(storefront.tenantId),
      marketRef: market.marketRef,
      sellingLegalEntityRef: market.sellingLegalEntityRef,
    };
    const held = byLocale.get(locale);
    const rank = (value: StorefrontMarketEntry) => (value.lifecycle === "ACTIVE" ? 0 : 1);
    if (
      held === undefined ||
      rank(entry) < rank(held) ||
      (rank(entry) === rank(held) && entry.marketCode < held.marketCode)
    )
      byLocale.set(locale, entry);
  }
  return [...byLocale.values()].sort((a, b) => a.marketCode.localeCompare(b.marketCode));
}

/**
 * Whether the market catalog knows any market of `legalEntityId` (any lifecycle) or any association of this
 * storefront. Without either, the storefront runs as one Czech CZK market (see UNMARKETED_MARKET).
 */
export function hasMarketData(catalog: unknown, legalEntityId: string): boolean {
  const body = isRaw(catalog) ? catalog : {};
  return (
    rows(body.markets).some(
      (market) =>
        isRaw(market.sellingLegalEntityRef) &&
        text(market.sellingLegalEntityRef.resourceId) === legalEntityId,
    ) ||
    rows(body.associations).some(
      (association) =>
        isRaw(association.storefrontRef) &&
        text(association.storefrontRef.appId) === STOREFRONT_APP_ID,
    )
  );
}

/**
 * The market owner is not available to this storefront at all: module not active in the composition
 * (gateway audience rejected), the read not granted, or not published. Not an outage (those stay errors).
 */
export const isMarketOwnerNotProvisioned = (error: unknown): boolean =>
  OntosError.is(error) &&
  (error.status === 403 ||
    error.status === 404 ||
    (error.status === 400 &&
      isRaw(error.body) &&
      error.body._tag === "GatewayAudienceInvalidProblem"));

/** The storefront's only market before any market exists: Czech, CZK, the whole published catalogue. */
export const UNMARKETED_LOCALE = "cs";
const UNMARKETED_MARKET: ActiveMarket = {
  marketCode: "",
  locale: UNMARKETED_LOCALE,
  formatLocale: "cs-CZ",
  currency: "CZK",
  configured: true,
};
const UNMARKETED_LIVE: LiveMarket[] = [
  { locale: UNMARKETED_LOCALE, marketCode: "", label: "CZ", currency: "CZK" },
];

/** This storefront's markets; `unmarketed`: no market data exists yet (see hasMarketData). */
export interface MarketDirectory {
  entries: StorefrontMarketEntry[];
  unmarketed: boolean;
}

/** Outcome of `resolve-commerce-market` for one explicitly selected market. */
export type ResolutionOutcome = "live" | "not-active" | "unknown";
export function resolutionOutcome(response: unknown, marketId: string): ResolutionOutcome {
  const body = isRaw(response) ? response : {};
  switch (body.outcome) {
    case "MARKET_RESOLVED": {
      const tuple = isRaw(body.selectedTuple) ? body.selectedTuple : {};
      const ref = isRaw(tuple.marketRef) ? tuple.marketRef : {};
      if (text(ref.resourceId) !== marketId || tuple.channel !== CHANNEL)
        throw new OntosError(
          "Market resolution selected another market",
          502,
          "market_resolution_mismatch",
        );
      return "live";
    }
    case "MARKET_NOT_ACTIVE":
    case "MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT":
      return "not-active";
    case "MARKET_NOT_ALLOWED_FOR_STOREFRONT":
    case "MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL":
      return "unknown";
    case "MARKET_ELIGIBILITY_UNAVAILABLE":
      throw new OntosError(
        "Market eligibility is unavailable",
        503,
        "market_eligibility_unavailable",
      );
    default:
      throw new OntosError(
        "Market resolution response is malformed",
        502,
        "market_resolution_malformed",
      );
  }
}

/** Merchandise market offer summary (`storefrontCatalog.market`). */
export interface MarketOffer {
  currency: StoreCurrency;
  configured: boolean;
}
export function marketOfferOf(body: unknown, marketId: string): MarketOffer {
  const market = isRaw(body) && isRaw(body.market) ? body.market : undefined;
  if (
    market === undefined ||
    text(market.marketId) !== marketId ||
    !isStoreCurrency(market.currency)
  )
    throw new OntosError(
      "Merchandise returned no market for the storefront catalog",
      502,
      "market_offer_malformed",
    );
  return { currency: market.currency, configured: market.configured !== false };
}

/** Isolate-local 60 s cache with in-flight sharing; failures are never cached. */
const ttlCache = <T>(ttlMs: number, limit: number) => {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const held = entries.get(key);
    if (held !== undefined && Date.now() - held.at < ttlMs) return held.value;
    entries.delete(key);
    if (entries.size >= limit) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    const value = load();
    entries.set(key, { at: Date.now(), value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
};

const directoryCache = ttlCache<MarketDirectory>(MARKET_CACHE_MS, 1);
const resolutionCache = ttlCache<ResolutionOutcome>(MARKET_CACHE_MS, 20);
const offerCache = ttlCache<MarketOffer>(MARKET_CACHE_MS, 20);

/** This storefront's associated markets (cached 60 s, also when the market owner is not provisioned). */
export const readMarketDirectory = (): Promise<MarketDirectory> =>
  directoryCache("", async () => {
    const now = Date.now();
    const { legalEntityId } = getConfig();
    let body: unknown;
    try {
      body = await readRecords(MARKET_CATALOG_AUDIENCE, "current-market-catalog", {
        at: new Date(now).toISOString(),
      });
    } catch (error) {
      if (!isMarketOwnerNotProvisioned(error)) throw error;
      console.warn(
        "[akros] commerce-market-catalog is not available to this storefront; serving /cs without a market",
      );
      return { entries: [], unmarketed: true };
    }
    return {
      entries: storefrontMarkets(body, now, legalEntityId),
      unmarketed: !hasMarketData(body, legalEntityId),
    };
  });

const resolveEntry = (entry: StorefrontMarketEntry): Promise<ResolutionOutcome> =>
  resolutionCache(entry.marketId, async () =>
    resolutionOutcome(
      await readRecords(MARKET_CATALOG_AUDIENCE, "resolve-commerce-market", {
        storefrontRef: { appId: STOREFRONT_APP_ID, tenantId: entry.tenantId },
        channel: CHANNEL,
        effectiveAt: new Date().toISOString(),
        explicitSelection: {
          marketRef: entry.marketRef,
          sellingLegalEntityRef: entry.sellingLegalEntityRef,
        },
      }),
      entry.marketId,
    ),
  );

/** Currency and offer state of one market (cached 60 s); the smallest product read that carries `market`. */
export const readMarketOffer = (marketId: string): Promise<MarketOffer> =>
  offerCache(marketId, async () =>
    marketOfferOf(
      await readRecords("merchandise", "records", {
        view: {
          storefront: true,
          storefrontCatalog: { marketId, pageSize: 1, fields: "card", includeCategories: false },
        },
      }),
      marketId,
    ),
  );

/** Markets a customer can open now, with their currency when merchandise reports it. */
async function liveMarkets(entries: StorefrontMarketEntry[]): Promise<LiveMarket[]> {
  const open = entries.filter((entry) => entry.lifecycle === "ACTIVE" && entry.marketEffective);
  const offers = await Promise.allSettled(open.map((entry) => readMarketOffer(entry.marketId)));
  return open.map((entry, index) => {
    const offer = offers[index];
    return {
      locale: entry.locale,
      marketCode: entry.marketCode,
      label: entry.label,
      ...(offer.status === "fulfilled" ? { currency: offer.value.currency } : {}),
    };
  });
}

/** Proxy routing only: whether a path locale is a live, unavailable or unknown market (no merchandise read). */
export async function storefrontMarketKind(locale: string): Promise<ResolutionOutcome> {
  const directory = await readMarketDirectory();
  if (directory.unmarketed) return locale === UNMARKETED_LOCALE ? "live" : "unknown";
  const entry = directory.entries.find((candidate) => candidate.locale === locale);
  return entry === undefined ? "unknown" : await resolveEntry(entry);
}

/** Resolves a path locale to the request's market (owner reads cached 60 s). */
export async function resolveStorefrontMarket(locale: string): Promise<MarketResolution> {
  const { entries, unmarketed } = await readMarketDirectory();
  if (unmarketed)
    return locale === UNMARKETED_LOCALE
      ? { kind: "live", market: UNMARKETED_MARKET, live: UNMARKETED_LIVE }
      : { kind: "unknown", locale, live: UNMARKETED_LIVE };
  const live = await liveMarkets(entries);
  const entry = isLocaleSegment(locale)
    ? entries.find((candidate) => candidate.locale === locale)
    : undefined;
  if (entry === undefined) return { kind: "unknown", locale, live };
  const outcome = await resolveEntry(entry);
  if (outcome === "unknown") return { kind: "unknown", locale, live };
  if (outcome === "not-active")
    return { kind: "not-active", locale, marketCode: entry.marketCode, live };
  const offer = await readMarketOffer(entry.marketId);
  return {
    kind: "live",
    market: {
      marketId: entry.marketId,
      marketCode: entry.marketCode,
      locale: entry.locale,
      formatLocale: entry.formatLocale,
      currency: offer.currency,
      configured: offer.configured,
    },
    live,
  };
}
