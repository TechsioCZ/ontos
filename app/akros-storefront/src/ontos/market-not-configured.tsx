"use client";
import { useDictionary } from "./market-context";

/** Catalog empty state of a market whose offer merchandise has not configured (`market.configured === false`). */
export function MarketNotConfigured() {
  const dictionary = useDictionary();
  return (
    <section
      aria-labelledby="market-not-configured-title"
      className="grid gap-3 p-4"
      data-market-not-configured=""
    >
      <h1 className="m-0 text-xl font-bold" id="market-not-configured-title">
        {dictionary.market.notConfiguredTitle}
      </h1>
      <p className="akros-empty-state m-0">{dictionary.market.notConfiguredDescription}</p>
    </section>
  );
}
