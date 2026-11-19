import type { Metadata } from "next";
import { headers } from "next/headers";
import { brandLocale, getBrand } from "@/brand";
import { dictionaryFor } from "@/i18n";
import { getMarketResolution, getStorePath } from "@/ontos/active-market";
import { isCatalogPath } from "@/ontos/market-locale";

export async function generateMetadata(): Promise<Metadata> {
  const [resolution, path, requestHeaders] = await Promise.all([
    getMarketResolution(),
    getStorePath(),
    headers(),
  ]);
  const brand = getBrand();
  const locale = resolution.kind === "live" ? resolution.market.locale : resolution.locale;
  const base: Metadata = {
    title: {
      default: brand.metadata.defaultTitle[brandLocale(locale)],
      template: `%s | ${brand.name}`,
    },
    robots: { index: false, follow: false, nocache: true },
    description: brand.metadata.description[brandLocale(locale)],
    icons: { icon: { url: brand.metadata.icon, type: "image/svg+xml", sizes: "any" } },
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
