import type { Metadata } from "next";

import { CatalogPagination } from "@/components/catalog-pagination";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { getDictionary } from "@/ontos/active-market";
import { getCatalogPage } from "@/ontos/catalog-server";
import { placeholdersLast, toSearchGridItem } from "@/ontos/search-suggestions";
import { readSearchVariantMatches } from "@/ontos/search-variants";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDictionary()).search.results };
}
const productsPerPage = 24;

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { page = "1", q = "" } = await searchParams;
  const cs = await getDictionary();
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
    const products = placeholdersLast(listing.products);
    // Listing cards carry no variant records: the page's variant groups are read in full to route each hit
    // to its exact variant (one hit) or to the variant table filtered by the query (several hits).
    const matches = await readSearchVariantMatches(products, term);
    items = products.map((product) =>
      toSearchGridItem(toProductSummary(product), term, cs, matches.get(product.id)),
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
        className="sf-section sf-product-listing-section"
        aria-labelledby="search-results-title"
      >
        <div className="sf-category-heading">
          <h1 id="search-results-title">{cs.search.results}</h1>
          {q && <p>{cs.search.query(q)}</p>}
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
          <p className="sf-empty-state">{cs.search.noResults}</p>
        )}
      </section>
    </StorefrontShell>
  );
}
