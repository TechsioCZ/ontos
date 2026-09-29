import type { Metadata } from "next";

import { CatalogPagination } from "@/components/catalog-pagination";
import { ProductGrid, type ProductGridItem } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import { getProductStockStatus } from "@/lib/product-stock";
import { searchCatalog, toProductSummary } from "@/mock-storefront/catalog";
import type { CatalogSearchResult } from "@/mock-storefront/types";

export const metadata: Metadata = { title: cs.search.results };
const productsPerPage = 24;

const toSearchGridItem = (
  { product, matchingVariants }: CatalogSearchResult,
  query: string,
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
  const { page = "1", q = "" } = await searchParams;
  const requestedPage = Number.parseInt(page, 10);
  const results = searchCatalog(q);
  const totalPages = Math.max(1, Math.ceil(results.length / productsPerPage));
  const currentPage = Math.min(
    Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1),
    totalPages,
  );
  const visibleResults = results.slice(
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
        {results.length > 0 ? (
          <>
            <ProductGrid products={visibleResults.map((result) => toSearchGridItem(result, q))} />
            <CatalogPagination
              currentPage={currentPage}
              itemCount={results.length}
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
