"use client";
import NextLink from "next/link";
import {
  AppRouterContext,
  type PrefetchOptions,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useContext, useRef, type ComponentProps } from "react";

/** A pointer resting this long on a link counts as intent (a pointer passing over the grid does not). */
const INTENT_DWELL_MS = 80;
/** Matches `experimental.staleTimes.static`: a prefetched page is reused this long, then fetched again. */
const INTENT_REUSE_MS = 30_000;
const prefetchedAt = new Map<string, number>();

type StoreLinkProps = ComponentProps<typeof NextLink> & {
  /** Load the full page when the shopper shows intent (pointer rests, touch, keyboard focus). */
  prefetchOnIntent?: boolean;
};

/**
 * Next.js Link that loads its page on click only. Every catalog page renders from OntOS on demand, so viewport
 * prefetch turned one page view into a render of each visible category and product link. Product links opt
 * into `prefetchOnIntent`: the page (and its OntOS read) starts before the click and the click reuses it.
 */
export default function StoreLink({
  prefetch = false,
  prefetchOnIntent = false,
  onMouseEnter,
  onMouseLeave,
  onTouchStart,
  onFocus,
  ...props
}: StoreLinkProps) {
  // The mounted App Router (absent when a component renders outside one, e.g. in component tests).
  const router = useContext(AppRouterContext);
  const dwell = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const href = typeof props.href === "string" ? props.href : undefined;
  const load = () => {
    if (href === undefined || router === null) return;
    const at = prefetchedAt.get(href);
    if (at !== undefined && Date.now() - at < INTENT_REUSE_MS) return;
    prefetchedAt.set(href, Date.now());
    router.prefetch(href, { kind: "full" as PrefetchOptions["kind"] });
  };
  const intent = prefetchOnIntent && href !== undefined;
  return (
    <NextLink
      prefetch={prefetch}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        if (intent) dwell.current = setTimeout(load, INTENT_DWELL_MS);
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        clearTimeout(dwell.current);
      }}
      onTouchStart={(event) => {
        onTouchStart?.(event);
        if (intent) load();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (intent) load();
      }}
      {...props}
    />
  );
}
