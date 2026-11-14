"use client";
// Browser side of the active market: the root layout passes the server-resolved market once per document.
// Market switches are full page loads, so one document never changes its market.
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { dictionaryFor, type Dictionary } from "@/i18n";
import { cs } from "@/i18n/cs";
import { CZK_MONEY, formatPrice, type MoneyFormat, type StoreCurrency } from "@/lib/format";
import { localizeHref, stripLocale } from "./market-locale";

/** Serializable market summary for the browser (no owner refs, no credentials). */
export interface ClientMarket {
  locale: string;
  marketCode: string;
  currency: StoreCurrency;
  formatLocale: string;
  configured: boolean;
  /** Markets a customer can open now (header switcher). */
  live: readonly { locale: string; marketCode: string; label: string; currency?: StoreCurrency }[];
}

interface MarketContextValue {
  /** Undefined outside a market (isolated component tests): links stay unprefixed, money is CZK. */
  market?: ClientMarket;
  dictionary: Dictionary;
  money: MoneyFormat;
}

const MarketContext = createContext<MarketContextValue>({ dictionary: cs, money: CZK_MONEY });

export function MarketProvider({
  market,
  children,
}: {
  market: ClientMarket;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({
      market,
      dictionary: dictionaryFor(market.locale),
      money: { currency: market.currency, locale: market.formatLocale },
    }),
    [market],
  );
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

export const useMarket = () => useContext(MarketContext).market;
/** UI chrome strings of the market locale. */
export const useDictionary = () => useContext(MarketContext).dictionary;
/** Currency and locale of the market's prices. */
export const useMoney = () => useContext(MarketContext).money;
/** Formats a minor-unit amount in the market currency. */
export function useFormatPrice() {
  const money = useMoney();
  return useCallback((priceMinor: number) => formatPrice(priceMinor, money), [money]);
}
/** Prefixes internal hrefs (`/kosik`) with the market locale (`/sk/kosik`). */
export function useStoreHref() {
  const locale = useMarket()?.locale;
  return useCallback((href: string) => localizeHref(href, locale), [locale]);
}
/** The current storefront route without the locale prefix (`/kosik/shrnuti`). */
export const useStorePathname = () => stripLocale(usePathname() ?? "/");
