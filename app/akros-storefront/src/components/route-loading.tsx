"use client";

import { useSyncExternalStore } from "react";
import { Skeleton } from "@techsio/ui-kit/atoms/skeleton";

import { StorefrontShell } from "@/components/storefront-shell";
import { useDictionary } from "@/ontos/market-context";

const subscribe = () => () => {};
const inBrowser = () => true;
const onServer = () => false;

/**
 * The route's loading state. A client navigation replaces the whole page, header included, so in the browser the
 * skeleton keeps the full shell around it. The server streams this fallback into every document before the page
 * itself, where it only fills the moment until the page arrives: there it is a frame of the shell's size, not one
 * more copy of the header, catalogue sidebar and footer (about 64 kB of hidden HTML per loading boundary).
 */
export function RouteLoading() {
  const cs = useDictionary();
  const browser = useSyncExternalStore(subscribe, inBrowser, onServer);
  const skeleton = (
    <div
      role="status"
      aria-busy="true"
      aria-label={cs.notifications.loading}
      data-route-loading=""
      className="grid gap-(--dimension-24)"
    >
      <Skeleton.Rectangle aria-hidden className="h-(--dimension-32) max-w-[60%] rounded-sm" />
      <div className="grid grid-cols-2 gap-(--dimension-16) md:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton.Rectangle aria-hidden key={index} className="aspect-[3/4] rounded-sm" />
        ))}
      </div>
    </div>
  );
  if (browser) return <StorefrontShell>{skeleton}</StorefrontShell>;
  return (
    <div className="sf-shell">
      <div aria-hidden="true" className="sf-route-loading__header" />
      <div className="sf-page-grid">
        <div aria-hidden="true" />
        <div className="sf-main">{skeleton}</div>
      </div>
    </div>
  );
}
