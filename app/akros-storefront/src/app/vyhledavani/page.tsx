import type { Metadata } from "next";

import { CatalogPagination } from "@/components/catalog-pagination";
import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import { searchProducts, toProductSummary } from "@/mock-storefront/catalog";

export const metadata: Metadata = { title: cs.search.results };
const productsPerPage = 24;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { page = "1", q = "" } = await searchParams;
  const requestedPage = Number.parseInt(page, 10);
  const products = searchProducts(q);
  const totalPages = Math.max(1, Math.ceil(products.length / productsPerPage));
  const currentPage = Math.min(
    Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1),
    totalPages,
  );
  const visibleProducts = products.slice(
    (currentPage - 1) * productsPerPage,
    currentPage * productsPerPage,
  );

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
          <>
            <ProductGrid products={visibleProducts.map(toProductSummary)} />
            <CatalogPagination
              currentPage={currentPage}
              itemCount={products.length}
              pageSize={productsPerPage}
              pathname="/vyhledavani"
              searchParams={{ q }}
            />
          </>
        ) : (
          <p className="akros-empty-state">{cs.search.noResults}</p>
        )}
      </section>
    </StorefrontShell>
  );
}
