import "server-only";
// Storefront market resolution (owner: commerce.market-catalog; offer/currency: merchandise).
//   1. `current-market-catalog {at}` (once per operation): associations of this storefront (configured app id), channel B2C,
//      effective now, sold by the configured legal entity → the market whose primary locale (supportedLocales[0]) is the path.
//   2. The market's own definition decides: ACTIVE and effective now = live market, SUSPENDED or outside its validity =
//      „dočasně nedostupný“, a locale without an association = unknown (404). (`resolve-commerce-market` needs a
//      trusted-storefront gateway context that the Shell gateway does not issue to the storefront service key.)
//   3. merchandise `storefrontCatalog {marketId}` returns the market's currency and whether its offer is configured.
// Before any market exists (no market of this seller, no association of this storefront, or the market owner not
// part of this storefront's approved composition yet), `/cs` serves the Czech CZK catalogue without a market filter; every other
// locale is unknown. As soon as one market or association exists, only the owners' markets are served.
// The path locale is only a selector: nothing a browser sends is used before the owners confirmed it.
import { Effect, Match } from "effect";
import { isOperationError } from "@ontos/storefront-runtime";
import { getConfig } from "./config";
import { createOperation, OntosError, readRecords } from "./gateway";
import type { OperationOptions } from "./gateway";
import { isLocaleSegment } from "./market-locale";
import { isStoreCurrency, type StoreCurrency } from "@/lib/format";

const MARKET_CATALOG_AUDIENCE = "commerce-market-catalog";
const CHANNEL = "B2C";

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

/** Which storefront this instance is in the market catalog (`getConfig()`: app id and selling legal entity). */
export interface StorefrontIdentity {
  appId: string;
  legalEntityId: string;
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
 * `identity.appId`, channel B2C, effective at `now`, sold by `identity.legalEntityId`; retired markets are excluded.
 * Two markets with the same path locale: an ACTIVE one wins, then the lower market code.
 */
export function storefrontMarkets(
  catalog: unknown,
  now: number,
  { appId, legalEntityId }: StorefrontIdentity,
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
      text(storefront.appId) !== appId ||
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
 * Whether the market catalog knows any market of `identity.legalEntityId` (any lifecycle) or any association of
 * this storefront. Without either, the storefront runs as one Czech CZK market (see UNMARKETED_MARKET).
 */
export function hasMarketData(
  catalog: unknown,
  { appId, legalEntityId }: StorefrontIdentity,
): boolean {
  const body = isRaw(catalog) ? catalog : {};
  return (
    rows(body.markets).some(
      (market) =>
        isRaw(market.sellingLegalEntityRef) &&
        text(market.sellingLegalEntityRef.resourceId) === legalEntityId,
    ) ||
    rows(body.associations).some(
      (association) =>
        isRaw(association.storefrontRef) && text(association.storefrontRef.appId) === appId,
    )
  );
}

/**
 * An audience rejection identifies a market owner absent from the approved composition.
 * A denied read or missing handler cannot prove that unrestricted catalogue access is appropriate.
 */
export const isMarketOwnerNotProvisioned = (error: unknown): boolean =>
  OntosError.is(error) &&
  error.status === 400 &&
  isRaw(error.body) &&
  Match.value(error.body).pipe(
    Match.when({ _tag: "GatewayAudienceInvalidProblem" }, () => true),
    Match.orElse(() => false),
  );

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

/** Whether one associated market is open now, from its definition in the market catalog. */
export type ResolutionOutcome = "live" | "not-active" | "unknown";
const outcomeOf = (entry: StorefrontMarketEntry): ResolutionOutcome =>
  entry.lifecycle === "ACTIVE" && entry.marketEffective ? "live" : "not-active";

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

/** Read the directory at this operation's instant; a denial is never proof of an empty installation. */
const loadMarketDirectory = async (options: OperationOptions): Promise<MarketDirectory> => {
  const now = Date.now();
  const { appId, legalEntityId } = getConfig();
  const identity: StorefrontIdentity = { appId, legalEntityId };
  let body: unknown;
  try {
    body = await readRecords(
      MARKET_CATALOG_AUDIENCE,
      "current-market-catalog",
      {
        at: new Date(now).toISOString(),
      },
      options,
    );
  } catch (error) {
    if (!isMarketOwnerNotProvisioned(error)) throw error;
    console.warn(
      "[akros] commerce-market-catalog is not available to this storefront; serving /cs without a market",
    );
    return { entries: [], unmarketed: true };
  }
  return {
    entries: storefrontMarkets(body, now, identity),
    unmarketed: !hasMarketData(body, identity),
  };
};

/** Read market currency and offer state without loading products or category trees. */
const loadMarketOffer = async (marketId: string, options: OperationOptions): Promise<MarketOffer> =>
  marketOfferOf(
    await readRecords(
      "merchandise",
      "records",
      {
        view: {
          storefront: true,
          storefrontCatalog: { marketId, mode: "categories", includeCategories: false },
        },
      },
      options,
    ),
    marketId,
  );

/** Promises belong to one operation, including rejected promises; no owner state crosses requests. */
export const createMarketReadOperation = (options: OperationOptions = {}) => {
  const owned = options.operation === undefined || options.signal !== undefined;
  const operation = owned
    ? Effect.runSync(
        createOperation({
          signal: options.operation
            ? AbortSignal.any([
                options.operation.signal,
                ...(options.signal ? [options.signal] : []),
              ])
            : options.signal,
          parent: options.operation,
        }),
      )
    : options.operation!;
  const lifetime = { operation };
  let directory: Promise<MarketDirectory> | undefined;
  const offers = new Map<string, Promise<MarketOffer>>();
  return {
    dispose: () => {
      if (owned) operation.dispose();
    },
    check: () => operation.check(),
    directory: (): Promise<MarketDirectory> => {
      operation.check();
      return (directory ??= loadMarketDirectory(lifetime));
    },
    offer: (marketId: string): Promise<MarketOffer> => {
      operation.check();
      const held = offers.get(marketId);
      if (held !== undefined) return held;
      const offer = loadMarketOffer(marketId, lifetime);
      offers.set(marketId, offer);
      return offer;
    },
  };
};
export type MarketReadOperation = ReturnType<typeof createMarketReadOperation>;
export type ActiveMarketResolution =
  | { kind: "live"; market: ActiveMarket }
  | { kind: "not-active"; locale: string; marketCode: string }
  | { kind: "unknown"; locale: string };

/** Markets a customer can open now, with currency when merchandise reports it. */
async function liveMarkets(
  entries: StorefrontMarketEntry[],
  operation: MarketReadOperation,
): Promise<LiveMarket[]> {
  const open = entries.filter((entry) => entry.lifecycle === "ACTIVE" && entry.marketEffective);
  const live: LiveMarket[] = open.map(({ locale, marketCode, label }) => ({
    locale,
    marketCode,
    label,
  }));
  let next = 0;
  const worker = async () => {
    while (next < open.length) {
      operation.check();
      const index = next++;
      try {
        const offer = await operation.offer(open[index].marketId);
        live[index].currency = offer.currency;
      } catch (error) {
        operation.check();
        if (isOperationError(error) && (error.kind === "cancelled" || error.kind === "deadline"))
          throw error;
        // Switcher currencies are optional, including when owner admission is saturated.
      }
    }
  };
  // Start owner work lazily: the number of open markets must not exhaust process admission.
  await Promise.all(Array.from({ length: Math.min(2, open.length) }, worker));
  operation.check();
  return live;
}

/** Proxy routing only. This is a separate operation from the subsequent Next render. */
export async function storefrontMarketKind(
  locale: string,
  options: OperationOptions = {},
): Promise<ResolutionOutcome> {
  const operation = createMarketReadOperation(options);
  try {
    const directory = await operation.directory();
    if (directory.unmarketed) return locale === UNMARKETED_LOCALE ? "live" : "unknown";
    const entry = directory.entries.find((candidate) => candidate.locale === locale);
    return entry === undefined ? "unknown" : outcomeOf(entry);
  } finally {
    operation.dispose();
  }
}

/** API reads need only the selected offer, never the switcher's all-market fanout. */
export async function resolveActiveStorefrontMarket(
  locale: string,
  operation?: MarketReadOperation,
): Promise<ActiveMarketResolution> {
  if (operation === undefined) {
    const owned = createMarketReadOperation();
    try {
      return await resolveActiveStorefrontMarket(locale, owned);
    } finally {
      owned.dispose();
    }
  }
  const { entries, unmarketed } = await operation.directory();
  if (unmarketed)
    return locale === UNMARKETED_LOCALE
      ? { kind: "live", market: UNMARKETED_MARKET }
      : { kind: "unknown", locale };
  const entry = isLocaleSegment(locale)
    ? entries.find((candidate) => candidate.locale === locale)
    : undefined;
  if (entry === undefined) return { kind: "unknown", locale };
  if (outcomeOf(entry) === "not-active")
    return { kind: "not-active", locale, marketCode: entry.marketCode };
  const offer = await operation.offer(entry.marketId);
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
  };
}

/** Render chrome and selected market share one directory and the same selected-offer promise. */
export async function resolveStorefrontMarket(
  locale: string,
  operation?: MarketReadOperation,
): Promise<MarketResolution> {
  if (operation === undefined) {
    const owned = createMarketReadOperation();
    try {
      return await resolveStorefrontMarket(locale, owned);
    } finally {
      owned.dispose();
    }
  }
  const { entries, unmarketed } = await operation.directory();
  // Required work takes precedence over optional switcher currencies.
  const resolution = await resolveActiveStorefrontMarket(locale, operation);
  const live = unmarketed ? UNMARKETED_LIVE : await liveMarkets(entries, operation);
  return { ...resolution, live };
}
