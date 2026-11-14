import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getBrand } from "@/brand";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { contentLocale } from "@/content/locale";
import { getDictionary } from "@/ontos/active-market";

// The brand's own manufacturing page; a brand without one (STOREFRONT_BRAND) answers 404.
export async function generateMetadata(): Promise<Metadata> {
  const { production } = getBrand();
  return production ? { title: production.pages[await contentLocale()].title } : {};
}

export default async function ManufacturingPage() {
  const { production } = getBrand();
  if (!production) notFound();
  const [locale, { header }] = await Promise.all([contentLocale(), getDictionary()]);
  const { title, page } = production.pages[locale];
  return (
    <StorefrontShell activeCategorySlug="akroscz-vyroba">
      <StorefrontBreadcrumbs items={[{ href: "/", label: header.home }, { label: title }]} />
      <article className="sf-content-page">{page}</article>
    </StorefrontShell>
  );
}
