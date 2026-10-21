import type { Metadata } from "next";

import { CatalogPagination } from "@/components/catalog-pagination";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import { getProductStockStatus } from "@/lib/product-stock";
import { getCatalog, getCatalogPage } from "@/ontos/catalog-server";
import { isOntos } from "@/ontos/config";
import { placeholdersLast } from "@/ontos/search-suggestions";
import type { CatalogSearchResult } from "@/mock-storefront/types";

export const metadata: Metadata = { title: cs.search.results };
const productsPerPage = 24;

const toSearchGridItem = (
  { product, matchingVariants }: CatalogSearchResult,
  query: string,
  toProductSummary: Awaited<ReturnType<typeof getCatalog>>["toProductSummary"],
): ProductGridItem => {
  const summary = toProductSummary(product);
  if (matchingVariants.length === 0) return summary;

  const matchedVariant = matchingVariants.length === 1 ? matchingVariants[0] : undefined;
  const variantQuery = matchedVariant?.sku ?? query.trim();
  const params = new URLSearchParams({ variant: variantQuery });

  return {
    ...summary,
    ...(matchedVariant && {
      imageSrc: matchedVariant.imageSrc ?? summary.imageSrc,
      priceMinor: matchedVariant.priceMinor,
      priceIsFrom: false,
      stock: {
        kind: "quantity" as const,
        minimumQuantity: matchedVariant.minimumQuantity,
        quantityStep: matchedVariant.quantityStep,
        packageQuantity: matchedVariant.packageQuantity,
        status: getProductStockStatus(matchedVariant),
        stockCount: matchedVariant.stockCount,
        unit: matchedVariant.unit,
      },
    }),
    detailHref: `/produkt/${product.slug}?${params.toString()}#product-variants`,
    searchMatchLabel: matchedVariant
      ? `Varianta: ${matchedVariant.label} · SKU ${matchedVariant.sku}`
      : `${matchingVariants.length.toLocaleString("cs-CZ")} odpovídajících variant`,
  };
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { searchCatalog, toProductSummary } = await getCatalog();
  const { page = "1", q = "" } = await searchParams;
  const requestedPage = Number.parseInt(page, 10);
  const requested = Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1);
  const term = q.trim();
  let visibleResults: CatalogSearchResult[] = [];
  let itemCount = 0;
  let currentPage = 1;
  if (isOntos()) {
    // OntOS searches the whole permitted catalog server-side and returns one page plus the total.
    if (term) {
      let listing = await getCatalogPage({ q: term, page: requested, pageSize: productsPerPage });
      const lastPage = Math.max(1, Math.ceil(listing.total / productsPerPage));
      if (requested > lastPage && listing.total > 0)
        listing = await getCatalogPage({ q: term, page: lastPage, pageSize: productsPerPage });
      const matches = new Map(
        listing.model.searchCatalog(term).map((result) => [result.product.id, result] as const),
      );
      // Kai's placeholder group "AKCE" matches almost every query: keep it, but after real goods.
      visibleResults = placeholdersLast(listing.products).map(
        (product) => matches.get(product.id) ?? { product, matchingVariants: [] },
      );
      itemCount = listing.total;
      currentPage = Math.min(requested, lastPage);
    }
  } else {
    const results = searchCatalog(q);
    itemCount = results.length;
    const totalPages = Math.max(1, Math.ceil(results.length / productsPerPage));
    currentPage = Math.min(requested, totalPages);
    visibleResults = results.slice(
      (currentPage - 1) * productsPerPage,
      currentPage * productsPerPage,
    );
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
        {itemCount > 0 && visibleResults.length > 0 ? (
          <>
            <ProductGrid
              products={visibleResults.map((result) =>
                toSearchGridItem(result, q, toProductSummary),
              )}
            />
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
