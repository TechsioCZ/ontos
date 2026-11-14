"use client";
import { usePathname } from "next/navigation";
import { dictionaryFor, dictionaryLanguage } from "@/i18n";
import { DEFAULT_MARKET_LOCALE, splitLocale } from "@/ontos/market-locale";
import { Unavailable } from "@/ontos/unavailable";
export default function GlobalError({ reset }: { reset: () => void }) {
  // No market provider survives a root layout failure: the path locale picks the language.
  const locale = splitLocale(usePathname() ?? "/").locale ?? DEFAULT_MARKET_LOCALE;
  const dictionary = dictionaryFor(locale);
  return (
    <html lang={dictionaryLanguage(locale)}>
      <head>
        {/* Replaces the root layout, so no brand is known here: a brand-neutral title. */}
        <title>{`${dictionary.errorPages.unavailableTitle} | DEMO`}</title>
        <meta name="robots" content="noindex, nofollow, noarchive" />
      </head>
      <body style={{ margin: 0 }}>
        <Unavailable reset={reset} dictionary={dictionary} />
      </body>
    </html>
  );
}
