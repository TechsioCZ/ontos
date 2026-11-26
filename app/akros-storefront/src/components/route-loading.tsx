"use client";

import { Skeleton } from "@techsio/ui-kit/atoms/skeleton";

import { StorefrontShell } from "@/components/storefront-shell";
import { useDictionary } from "@/ontos/market-context";

/** Streamed at the first response chunk while the server renders the page. */
export function RouteLoading() {
  const cs = useDictionary();
  return (
    <StorefrontShell>
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
    </StorefrontShell>
  );
}
