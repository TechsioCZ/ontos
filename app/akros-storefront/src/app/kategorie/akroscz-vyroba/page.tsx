import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getBrand } from "@/brand";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";

// The brand's own manufacturing page; a brand without one (STOREFRONT_BRAND) answers 404.
export function generateMetadata(): Metadata {
  const { production } = getBrand();
  return production ? { title: production.title } : {};
}

export default function ManufacturingPage() {
  const { production } = getBrand();
  if (!production) notFound();
  return (
    <StorefrontShell activeCategorySlug="akroscz-vyroba">
      <StorefrontBreadcrumbs items={[{ href: "/", label: "Domů" }, { label: production.title }]} />
      <article className="sf-content-page">{production.page}</article>
    </StorefrontShell>
  );
}
