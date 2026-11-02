"use client";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { useDictionary, useMarket } from "./market-context";
import { marketLabel } from "./market-pages";

/**
 * Compact header switcher of the live markets („CZ · Kč“, „SK · €“, „EN · €“). Links open the other market's
 * homepage as a full page load: each market has its own offer, prices, currency and carts.
 */
export function MarketSwitcher() {
  const market = useMarket();
  const dictionary = useDictionary();
  if (!market || market.live.length < 2) return null;
  return (
    <nav
      aria-label={dictionary.market.switcherLabel}
      className="flex items-center"
      data-akros-market-switcher=""
    >
      {market.live.map((entry) => (
        <LinkButton
          key={entry.locale}
          aria-current={entry.locale === market.locale ? "page" : undefined}
          className="leading-(--text-sm--line-height)"
          href={`/${entry.locale}`}
          hrefLang={entry.locale}
          lang={entry.locale}
          size="sm"
          theme="borderless"
          variant="secondary"
        >
          {marketLabel(entry)}
        </LinkButton>
      ))}
    </nav>
  );
}
