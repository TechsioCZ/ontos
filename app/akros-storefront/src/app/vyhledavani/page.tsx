import type { Metadata } from "next";

import { CatalogPagination } from "@/components/catalog-pagination";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import { getCatalogPage, type CatalogModel } from "@/ontos/catalog-server";
import { placeholdersLast } from "@/ontos/search-suggestions";
import type { CatalogProduct } from "@/ontos/catalog-types";

export const metadata: Metadata = { title: cs.search.results };
const productsPerPage = 24;

// Listing cards carry no variant records: a variant group opens with its variant table filtered by the query.
const toSearchGridItem = (
  product: CatalogProduct,
  query: string,
  toProductSummary: CatalogModel["toProductSummary"],
): ProductGridItem => {
  const summary = toProductSummary(product);
  if (!summary.hasVariants) return summary;
  const params = new URLSearchParams({ variant: query });
  return { ...summary, detailHref: `/produkt/${product.slug}?${params.toString()}` };
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { page = "1", q = "" } = await searchParams;
  const requestedPage = Number.parseInt(page, 10);
  const requested = Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1);
  const term = q.trim();
  let items: ProductGridItem[] = [];
  let itemCount = 0;
  let currentPage = 1;
  // OntOS searches the whole permitted catalog server-side and returns one page plus the total.
  if (term) {
    let listing = await getCatalogPage({ q: term, page: requested, pageSize: productsPerPage });
    const lastPage = Math.max(1, Math.ceil(listing.total / productsPerPage));
    if (requested > lastPage && listing.total > 0)
      listing = await getCatalogPage({ q: term, page: lastPage, pageSize: productsPerPage });
    // Kai's placeholder group "AKCE" matches almost every query: keep it, but after real goods.
    const { toProductSummary } = listing.model;
    items = placeholdersLast(listing.products).map((product) =>
      toSearchGridItem(product, term, toProductSummary),
    );
    itemCount = listing.total;
    currentPage = Math.min(requested, lastPage);
  }

  return (
    <StorefrontShell>
      <StorefrontBreadcrumbs
        items={[{ href: "/", label: cs.header.home }, { label: cs.search.results }]}
      />
      <section
        className="akros-section akros-product-listing-section"
        aria-labelledby="search-results-title"
      >
        <div className="akros-category-heading">
          <h1 id="search-results-title">{cs.search.results}</h1>
          {q && <p>Dotaz: „{q}“</p>}
        </div>
        {itemCount > 0 && items.length > 0 ? (
          <>
            <ProductGrid products={items} />
            <CatalogPagination
              currentPage={currentPage}
              itemCount={itemCount}
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
