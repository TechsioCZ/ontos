import { getShellSnapshot } from "@/ontos/catalog-server";
import { CatalogProvider } from "@/ontos/catalog-provider";
import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import "./globals.css";

import { CartProvider } from "@/features/cart/cart-provider";
import { CartNotifications } from "@/features/cart/cart-notifications";
import { dictionaryFor, dictionaryLanguage } from "@/i18n";
import { getMarketResolution, getStorePath, toClientMarket } from "@/ontos/active-market";
import { MarketProvider } from "@/ontos/market-context";
import { isCatalogPath } from "@/ontos/market-locale";
import { MarketGatePage } from "@/ontos/market-pages";

// Inter is split into two pre-built files (see app/scripts/fonts/subset-fonts.mjs): a preloaded core
// with ASCII, Latin-1, Latin Extended-A and the punctuation Czech copy needs, plus a lazily fetched
// extended file behind unicode-range. Together they keep the complete non-CJK coverage of the
// upstream InterVariable-latin.woff2, so every character the shop can render keeps the same outlines,
// widths and metrics. The core also carries the combining marks and every kerned character, because a
// pair split across the two files would lose its kerning; the extended face lives in
// fonts/inter-extended.generated.css.
//
// next/font/local only accepts literal option values, so the core range is written out below;
// `node app/scripts/fonts/subset-fonts.mjs` rewrites it when the subset changes.
const inter = localFont({
  src: "../fonts/InterVariable-core.woff2",
  weight: "400 900",
  style: "normal",
  display: "swap",
  variable: "--font-akros",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0020-007E, U+00A0-00AC, U+00AE-0148, U+014A-017F, U+0192, U+0218-021B, U+02D2-02D3, U+0300-0304, U+0306-0308, U+030A, U+030C, U+0327, U+2010, U+2013-2014, U+2018-2023, U+2026, U+2034, U+2039-203A, U+203D, U+2043-2044, U+204A-204D, U+204F, U+2071, U+2074, U+2077, U+2079-207B, U+207E-208E, U+2090-2093, U+2095-209C, U+20A1, U+20A7-20A8, U+20AB-20AC, U+20AF, U+20B2, U+20B4-20B5, U+20B8, U+20BD, U+20BF, U+2116-2117, U+211E-211F, U+2122, U+2126, U+2132, U+2160-216B, U+216F, U+2190, U+2192, U+2212, U+221E, U+2248, U+2260, U+2264-2265",
    },
  ],
});

export async function generateMetadata(): Promise<Metadata> {
  const [resolution, path, requestHeaders] = await Promise.all([
    getMarketResolution(),
    getStorePath(),
    headers(),
  ]);
  const base: Metadata = {
    title: {
      default: "AKROS | Nerezový a spojovací materiál",
      template: "%s | AKROS",
    },
    robots: { index: false, follow: false, nocache: true },
    description:
      "E-shop AKROS s nerezovým, hutním a spojovacím materiálem v prezentačním prostředí OntOS.",
  };
  if (resolution.kind !== "live") {
    const dictionary = dictionaryFor(resolution.locale);
    return {
      ...base,
      title:
        resolution.kind === "unknown"
          ? dictionary.market.unknownTitle
          : dictionary.market.unavailableTitle,
    };
  }
  const protocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const host = requestHeaders.get("host");
  const href = (locale: string) => `/${locale}${path === "/" ? "" : path}`;
  return {
    ...base,
    ...(host ? { metadataBase: new URL(`${protocol}://${host}`) } : {}),
    // Catalog pages carry hreflang alternates for every live market (same path, other market).
    alternates: {
      canonical: href(resolution.market.locale),
      ...(isCatalogPath(path)
        ? {
            languages: Object.fromEntries(
              resolution.live.map((market) => [market.locale, href(market.locale)]),
            ),
          }
        : {}),
    },
  };
}

export const dynamic = "force-dynamic";
export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const resolution = await getMarketResolution();
  if (resolution.kind !== "live")
    // Unknown locale (root 404 status) or an inactive market: no catalog, cart or market data.
    return (
      <html
        lang={dictionaryLanguage(resolution.locale)}
        className={`${inter.variable} light`}
        data-scroll-behavior="smooth"
      >
        <body>
          <MarketGatePage
            dictionary={dictionaryFor(resolution.locale)}
            kind={resolution.kind}
            live={resolution.live}
          />
        </body>
      </html>
    );
  const snapshot = await getShellSnapshot();
  const market = toClientMarket(resolution);
  return (
    <html lang={market.locale} className={`${inter.variable} light`} data-scroll-behavior="smooth">
      <body>
        <MarketProvider market={market}>
          <CatalogProvider snapshot={snapshot}>
            {/* Each market keeps its own carts: prices and currency differ between markets. */}
            <CartProvider storageScope={market.marketCode}>
              {children}
              <CartNotifications />
            </CartProvider>
          </CatalogProvider>
        </MarketProvider>
      </body>
    </html>
  );
}
