import type { Metadata } from "next";

import { getBrand } from "@/brand";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { contentLocale } from "@/content/locale";
import { getDictionary } from "@/ontos/active-market";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).header.about };
}

export default async function AboutPage() {
  const [locale, { header }] = await Promise.all([contentLocale(), getDictionary()]);
  return (
    <StorefrontShell>
      <StorefrontBreadcrumbs items={[{ href: "/", label: header.home }, { label: header.about }]} />
      <article className="sf-content-page">{getBrand().pages.about[locale]}</article>
    </StorefrontShell>
  );
}
