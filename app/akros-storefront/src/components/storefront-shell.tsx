"use client";
import type { ReactNode } from "react";

import { CatalogSidebar } from "@/components/catalog-sidebar";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { useCatalog } from "@/ontos/catalog-provider";
import { MarketNotConfigured } from "@/ontos/market-not-configured";
import { useMarket, useStorePathname } from "@/ontos/market-context";
import { isCatalogPath } from "@/ontos/market-locale";

export function StorefrontShell({
  activeCategorySlug,
  children,
}: {
  activeCategorySlug?: string;
  children: ReactNode;
}) {
  const { getSidebarCategories } = useCatalog();
  // A market without a merchandise offer sells nothing yet: catalog pages show one friendly empty state.
  // Content pages (about, contacts, …) stay readable.
  const market = useMarket();
  const pathname = useStorePathname();
  const unconfigured = market?.configured === false && isCatalogPath(pathname);
  return (
    <div className="sf-shell">
      <SiteHeader />
      <div className="sf-page-grid">
        <CatalogSidebar
          activeSlug={activeCategorySlug}
          categories={getSidebarCategories(activeCategorySlug)}
        />
        <main className="sf-main">{unconfigured ? <MarketNotConfigured /> : children}</main>
      </div>
      <SiteFooter />
    </div>
  );
}

export function StorefrontWideShell({
  children,
  fullBleed = false,
}: {
  children: ReactNode;
  fullBleed?: boolean;
}) {
  const { getSidebarCategories } = useCatalog();
  return (
    <div className="sf-shell">
      <SiteHeader />
      <main className={fullBleed ? "sf-wide-main sf-wide-main--full-bleed" : "sf-wide-main"}>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
