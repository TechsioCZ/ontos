"use client";
import type { ReactNode } from "react";

import { CatalogSidebar } from "@/components/catalog-sidebar";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { useCatalog } from "@/ontos/catalog-provider";

export function StorefrontShell({
  activeCategorySlug,
  children,
}: {
  activeCategorySlug?: string;
  children: ReactNode;
}) {
  const { getSidebarCategories } = useCatalog();
  return (
    <div className="akros-shell">
      <SiteHeader />
      <div className="akros-page-grid">
        <CatalogSidebar
          activeSlug={activeCategorySlug}
          categories={getSidebarCategories(activeCategorySlug)}
        />
        <main className="akros-main">{children}</main>
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
    <div className="akros-shell">
      <SiteHeader />
      <main
        className={fullBleed ? "akros-wide-main akros-wide-main--full-bleed" : "akros-wide-main"}
      >
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
