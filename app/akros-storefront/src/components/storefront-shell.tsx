import type { ReactNode } from "react";

import { CatalogSidebar } from "@/components/catalog-sidebar";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export function StorefrontShell({
  activeCategorySlug,
  children,
}: {
  activeCategorySlug?: string;
  children: ReactNode;
}) {
  return (
    <div className="akros-shell">
      <SiteHeader />
      <div className="akros-page-grid">
        <CatalogSidebar activeSlug={activeCategorySlug} />
        <main className="akros-main">{children}</main>
      </div>
      <SiteFooter />
    </div>
  );
}

export function StorefrontWideShell({ children }: { children: ReactNode }) {
  return (
    <div className="akros-shell">
      <SiteHeader />
      <main className="akros-wide-main">{children}</main>
      <SiteFooter />
    </div>
  );
}
