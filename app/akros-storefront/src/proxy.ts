import { NextResponse, type NextRequest } from "next/server";
import { hasCredentialQuery } from "@/ontos/credential-url";
import { requestOrigin } from "@/ontos/http";
import { storefrontMarketKind } from "@/ontos/market";
import {
  DEFAULT_MARKET_LOCALE,
  MARKET_LOCALE_HEADER,
  splitLocale,
  STORE_PATH_HEADER,
  UNAVAILABLE_MARKET_PATH,
  UNKNOWN_MARKET_PATH,
} from "@/ontos/market-locale";

/** Unprefixed by design: BFF routes, Next assets, OntOS customer-context callbacks and public files. */
const passThrough = (pathname: string, locale: string | undefined) =>
  /^\/(?:api|_next|commerce-customer-context-api|storefront|akros|sroubshop)(?:\/|$)/u.test(
    pathname,
  ) ||
  (locale === undefined && /^\/[^/]*\.[A-Za-z0-9]+$/u.test(pathname));

const ITEM_PATH = /^\/(?:produkt|kategorie)\/[^/]+\/?$/u;

/** A document request for a product or category the market does not sell (soft navigations skip). */
const missingItem = async (rest: string, headers: Headers, signal: AbortSignal) => {
  if (!ITEM_PATH.test(rest) || rest.startsWith("/kategorie/akroscz-vyroba")) return false;
  if (headers.has("rsc") || headers.has("next-router-prefetch")) return false;
  const probe = new URL("/api/ontos/exists", `http://127.0.0.1:${process.env.PORT ?? "3000"}`);
  probe.searchParams.set("path", rest);
  const forwarded = new Headers({
    [MARKET_LOCALE_HEADER]: headers.get(MARKET_LOCALE_HEADER) ?? "",
  });
  for (const name of ["x-forwarded-host", "x-forwarded-proto"]) {
    const value = headers.get(name);
    if (value) forwarded.set(name, value);
  }
  try {
    const response = await fetch(probe, {
      headers: forwarded,
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    return response.status === 404;
  } catch {
    return false;
  }
};

/**
 * Path-based markets. `/{locale}/rest` is rewritten to Kai's existing route `/rest` with the locale in a
 * request header (a browser-sent header of the same name is overwritten). Legacy URLs without a locale
 * redirect permanently (308) into the Czech market, keeping the query.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const { locale, rest } = splitLocale(pathname);
  if (hasCredentialQuery(request.nextUrl)) {
    // Next's proxy adapter requires an absolute redirect, using the browser's origin rather than its loopback URL.
    const response = NextResponse.redirect(
      new URL(`/${locale ?? DEFAULT_MARKET_LOCALE}/prihlaseni`, requestOrigin(request)),
      303,
    );
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
  if (passThrough(pathname, locale)) return NextResponse.next();
  if (locale === undefined)
    return NextResponse.redirect(
      new URL(
        `/${DEFAULT_MARKET_LOCALE}${pathname === "/" ? "" : pathname}${search}`,
        requestOrigin(request),
      ),
      308,
    );
  // An owner outage is reported by the render (catalog error page), never as an unknown market.
  const kind = await storefrontMarketKind(locale, { signal: request.signal }).catch(
    () => "live" as const,
  );
  // NextURL normalizes loopback IPs to localhost. Rewrites must keep the receiving
  // server origin, otherwise Next treats them as external and runs the proxy again.
  const target = new URL(request.url);
  target.pathname =
    kind === "unknown"
      ? UNKNOWN_MARKET_PATH
      : kind === "not-active"
        ? UNAVAILABLE_MARKET_PATH
        : rest;
  const headers = new Headers(request.headers);
  headers.set(MARKET_LOCALE_HEADER, locale);
  headers.set(STORE_PATH_HEADER, rest);
  // The loading shell streams a 200 before the page can call notFound(): decide existence first for documents.
  if (kind === "live" && (await missingItem(rest, headers, request.signal)))
    target.pathname = UNKNOWN_MARKET_PATH;
  return NextResponse.rewrite(target, { request: { headers } });
}
