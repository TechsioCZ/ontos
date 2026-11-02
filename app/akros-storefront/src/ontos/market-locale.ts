/**
 * Path-based storefront markets (`/cs/...`, `/sk/...`, `/en/...`). Shared by the proxy, server and browser:
 * no credentials, no OntOS reads. The locale segment only *selects* a market; the server always resolves it
 * against `commerce.market-catalog` (src/ontos/market.ts) before using it.
 */

/** Request header carrying the path locale: set by the proxy for pages, sent by the browser to API routes. */
export const MARKET_LOCALE_HEADER = "x-akros-market-locale";
/** Proxy → render: the storefront path without the locale prefix (canonical/hreflang). */
export const STORE_PATH_HEADER = "x-akros-store-path";
/**
 * Proxy rewrite targets that read no market data: an unknown locale matches no route (root 404 status),
 * an inactive market renders an empty page (200, noindex) whose content the root layout replaces.
 */
export const UNKNOWN_MARKET_PATH = "/_akros-unknown-market";
export const UNAVAILABLE_MARKET_PATH = "/trh-nedostupny";
/** Legacy URLs without a locale redirect into the Czech market. */
export const DEFAULT_MARKET_LOCALE = "cs";

/** Existing top-level routes whose name would also look like a locale segment. */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["api", "faq"]);

/** A path segment that addresses a market: 2–3 lowercase letters (ISO 639 language), not an existing route. */
export const isLocaleSegment = (segment: string | undefined | null): segment is string =>
  typeof segment === "string" && /^[a-z]{2,3}$/u.test(segment) && !RESERVED_SEGMENTS.has(segment);

/** `/sk/kategorie/x` → `{ locale: "sk", rest: "/kategorie/x" }`; `/kategorie/x` → `{ rest: "/kategorie/x" }`. */
export function splitLocale(pathname: string): { locale?: string; rest: string } {
  const match = /^\/([^/]+)(\/.*)?$/u.exec(pathname);
  if (match && isLocaleSegment(match[1])) return { locale: match[1], rest: match[2] || "/" };
  return { rest: pathname || "/" };
}

/** The storefront path without its locale prefix (identical on server and browser, so no hydration mismatch). */
export const stripLocale = (pathname: string): string => splitLocale(pathname).rest;

/**
 * Prefixes an internal absolute href (`/kosik`, `/produkt/x?variant=y`, `/`) with the market locale.
 * External, protocol-relative, hash-only and already prefixed hrefs are returned unchanged.
 */
export function localizeHref(href: string, locale: string | undefined): string {
  if (!locale || !href.startsWith("/") || href.startsWith("//")) return href;
  if (/^\/([^/?#]*)/u.exec(href)?.[1] === locale) return href;
  // `/`, `/?q=…` and `/#…` address the market's homepage.
  return /^\/(?:[?#]|$)/u.test(href) ? `/${locale}${href.slice(1)}` : `/${locale}${href}`;
}

/** Price-bearing catalog routes (hreflang alternates; the „not configured“ empty state of a market). */
export const isCatalogPath = (path: string): boolean =>
  /^\/(?:$|kategorie\/|produkt\/|vyhledavani$|novinky-a-akce$)/u.test(path);

/** Browser only: the market header for `/api/ontos/*` calls, derived from the current location's path. */
export function marketRequestHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const { locale } = splitLocale(window.location.pathname);
  return locale ? { [MARKET_LOCALE_HEADER]: locale } : {};
}
