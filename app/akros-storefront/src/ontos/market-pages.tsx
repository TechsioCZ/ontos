import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import type { Dictionary } from "@/i18n";
import { currencySymbol } from "@/lib/format";
import type { LiveMarket } from "./market";

/** Full page for a market path without a live market: unknown (404) or temporarily unavailable (200, noindex). */
export function MarketGatePage({
  kind,
  dictionary,
  live,
}: {
  kind: "unknown" | "not-active";
  dictionary: Dictionary;
  live: readonly LiveMarket[];
}) {
  const title =
    kind === "unknown" ? dictionary.market.unknownTitle : dictionary.market.unavailableTitle;
  const description =
    kind === "unknown"
      ? dictionary.market.unknownDescription
      : dictionary.market.unavailableDescription;
  return (
    <main className="grid min-h-screen place-items-center bg-(--color-base) p-6">
      <section
        aria-labelledby="market-gate-title"
        className="grid max-w-[40rem] gap-4 rounded-md bg-base-light p-8"
        data-market-gate={kind}
      >
        <p className="m-0 text-sm font-extrabold tracking-widest">
          AKROS <span className="font-normal tracking-normal">· DEMO</span>
        </p>
        <h1 className="m-0 text-xl font-bold" id="market-gate-title">
          {title}
        </h1>
        <p className="m-0 leading-normal">{description}</p>
        <h2 className="m-0 text-md font-bold">{dictionary.market.liveMarkets}</h2>
        {live.length ? (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {live.map((market) => (
              <li key={market.locale}>
                {/* A market switch is a full page load: another market has its own cart and prices. */}
                <LinkButton href={`/${market.locale}`} size="sm" theme="outlined" variant="primary">
                  {marketLabel(market)}
                </LinkButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0">{dictionary.market.noLiveMarkets}</p>
        )}
      </section>
    </main>
  );
}

/** „CZ · Kč“, „SK · €“, „EN · €“. */
export function marketLabel(market: Pick<LiveMarket, "label" | "currency" | "locale">): string {
  if (market.currency === undefined) return market.label;
  const symbol = currencySymbol({ currency: market.currency, locale: market.locale });
  return `${market.label} · ${symbol}`;
}
