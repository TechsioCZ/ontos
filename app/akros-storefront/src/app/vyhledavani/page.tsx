import type { Metadata } from "next";

import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import { searchProducts } from "@/mock-storefront/catalog";

export const metadata: Metadata = { title: cs.search.results };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const products = searchProducts(q);

  return (
    <StorefrontShell>
      <StorefrontBreadcrumbs
        items={[{ href: "/", label: cs.header.home }, { label: cs.search.results }]}
      />
      <section className="akros-section" aria-labelledby="search-results-title">
        <div className="akros-category-heading">
          <h1 id="search-results-title">{cs.search.results}</h1>
          {q && <p>Dotaz: „{q}“</p>}
        </div>
        {products.length > 0 ? (
          <ProductGrid products={products} />
        ) : (
          <p className="akros-empty-state">{cs.search.noResults}</p>
        )}
      </section>
    </StorefrontShell>
  );
}
