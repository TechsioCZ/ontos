"use client";
import NextLink from "next/link";
import type { ComponentProps } from "react";
import { useMarket } from "@/ontos/market-context";
import { localizeHref } from "@/ontos/market-locale";

type Href = ComponentProps<typeof NextLink>["href"];

/** Internal hrefs stay inside the current market: `/kosik` → `/sk/kosik`. */
const marketHref = (href: Href, locale: string | undefined): Href =>
  typeof href === "string"
    ? localizeHref(href, locale)
    : typeof href.pathname === "string"
      ? { ...href, pathname: localizeHref(href.pathname, locale) }
      : href;

/** Catalog pages carry fresh prices and stock: fetch on navigation, never prefetch a price-bearing RSC. */
export default function StoreLink({ href, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink {...props} href={marketHref(href, useMarket()?.locale)} prefetch={false} />;
}
