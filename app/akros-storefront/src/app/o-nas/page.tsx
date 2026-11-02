import type { Metadata } from "next";

import { getBrand } from "@/brand";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";

export const metadata: Metadata = { title: "O nás" };

export default function AboutPage() {
  return (
    <StorefrontShell>
      <StorefrontBreadcrumbs items={[{ href: "/", label: "Domů" }, { label: "O nás" }]} />
      <article className="sf-content-page">{getBrand().pages.about}</article>
    </StorefrontShell>
  );
}
