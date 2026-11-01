// The staff "E-shopy" overview (DESIGN 4): every registered e-shop with the markets it sells in, and the markets no
// e-shop sells in yet. Pure: joins the storefront registry list, the current market catalog and the merchandise
// market settings by their references; it never shows a technical identifier.
import type { MarketCurrency, MarketSettings } from '@app/merchandise/domain/market-offers';
import type {
  StorefrontApplicationLifecycle,
  StorefrontApplicationSummary,
} from '@app/storefront-registry/api/storefront-applications';
import type { CurrentMarketCatalogResponse } from '../../shared/apis/current-market-catalog.ts';
import type { MarketLifecycle } from '../../shared/market-contracts.ts';

export type CurrentMarket = CurrentMarketCatalogResponse['markets'][number];
export type CurrentAssociation = CurrentMarketCatalogResponse['associations'][number];
export type MarketChannel = CurrentMarket['channels'][number];

/** Display names of the demo e-shops; any other registration is numbered instead of showing its key. */
const storefrontNames = new Map([
  ['akros-storefront', 'AKROS e-shop'],
  ['kavarna-doma-eshop', 'Kavárna doma e-shop'],
]);

/** Public origins of the deployed e-shops; the market path follows it (`/cs`, `/sk`, `/en`). */
const storefrontOrigins = new Map([['akros-storefront', 'https://ontos-stage-akros.web-revolution.cz']]);

/** The e-shop's display name; `unnamed(position)` labels a registration without a known name. */
export const storefrontName = (appId: string, position: number, unnamed: (position: number) => string): string =>
  storefrontNames.get(appId) ?? unnamed(position);

/** The live URL of the e-shop for one market language, when the e-shop is deployed publicly. */
export const storefrontUrl = (appId: string, locale?: string): string | undefined => {
  const origin = storefrontOrigins.get(appId);
  if (origin === undefined) {
    return undefined;
  }
  return locale === undefined ? origin : `${origin}/${locale.split('-')[0] ?? locale}`;
};

/** One market as a chip: what the e-shop sells there and how. */
export interface MarketChip {
  readonly channel: MarketChannel | undefined;
  readonly code: string;
  readonly currency: MarketCurrency | undefined;
  readonly lifecycle: MarketLifecycle;
  readonly locale: string | undefined;
  readonly marketId: string;
  readonly url: string | undefined;
}

export interface EshopCard {
  readonly appId: string;
  readonly channels: readonly MarketChannel[];
  readonly lifecycle: StorefrontApplicationLifecycle;
  readonly markets: readonly MarketChip[];
  readonly name: string;
  /** The e-shop's home in its first market language (or its origin), when deployed publicly. */
  readonly url: string | undefined;
}

export interface EshopsOverview {
  readonly eshops: readonly EshopCard[];
  /** Markets of the company that no e-shop currently sells in. */
  readonly unassigned: readonly MarketChip[];
}

const byCode = (left: { readonly code: string }, right: { readonly code: string }) =>
  left.code.localeCompare(right.code, 'cs');

const currencyOf = (settings: readonly MarketSettings[], marketId: string): MarketCurrency | undefined =>
  settings.find((candidate) => candidate.marketId === marketId)?.currency;

/** A market chip; `association` is the e-shop it is sold in (none for a market without an e-shop). */
const chipOf = (
  market: CurrentMarket,
  settings: readonly MarketSettings[],
  association?: CurrentAssociation,
): MarketChip => {
  const [locale] = market.supportedLocales;
  return {
    channel: association?.channel,
    code: market.marketCode,
    currency: currencyOf(settings, market.marketRef.resourceId),
    lifecycle: market.lifecycle,
    locale,
    marketId: market.marketRef.resourceId,
    url: association === undefined ? undefined : storefrontUrl(association.storefrontRef.appId, locale),
  };
};

/** Joins the three reads into e-shop cards (registry order kept by name) and the unassigned markets. */
export const eshopsOverview = (input: {
  readonly associations: readonly CurrentAssociation[];
  readonly markets: readonly CurrentMarket[];
  readonly settings: readonly MarketSettings[];
  readonly storefronts: readonly StorefrontApplicationSummary[];
  readonly unnamed: (position: number) => string;
}): EshopsOverview => {
  const marketsById = new Map(input.markets.map((market) => [market.marketRef.resourceId, market]));
  const eshops = input.storefronts
    .map((storefront, index): EshopCard => {
      const markets = input.associations
        .flatMap((association) => {
          const market = marketsById.get(association.marketRef.resourceId);
          return market === undefined || association.storefrontRef.appId !== storefront.storefrontAppId
            ? []
            : [chipOf(market, input.settings, association)];
        })
        .toSorted(byCode);
      const firstLocale = markets.find((chip) => chip.locale !== undefined)?.locale;
      return {
        appId: storefront.storefrontAppId,
        channels: storefront.allowedChannels,
        lifecycle: storefront.lifecycle,
        markets,
        name: storefrontName(storefront.storefrontAppId, index + 1, input.unnamed),
        url: storefrontUrl(storefront.storefrontAppId, firstLocale),
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name, 'cs'));
  const associated = new Set(input.associations.map((association) => association.marketRef.resourceId));
  const unassigned = input.markets
    .flatMap((market) => (associated.has(market.marketRef.resourceId) ? [] : [chipOf(market, input.settings)]))
    .toSorted(byCode);
  return { eshops, unassigned };
};
