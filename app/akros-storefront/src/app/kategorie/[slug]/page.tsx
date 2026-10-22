import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CategoryGrid } from "@/components/category-grid";
import { CategoryFilters } from "@/components/category-filters";
import {
  parseCategoryFilters,
  categoryFilterParams,
  type CategoryQuery,
} from "@/ontos/category-filters";
import { CatalogPagination } from "@/components/catalog-pagination";
import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { CategoryBranch } from "@/ontos/category-branch";
import { cs } from "@/i18n/cs";
import { getCatalog, getCatalogPage, type CatalogQuery } from "@/ontos/catalog-server";
import { categoryDescription } from "@/lib/category-presentation";

interface CategoryPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<CategoryQuery>;
}

const productsPerPage = 24;

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = (await getCatalog(slug)).getCategoryBySlug(slug);

  return { title: category?.name ?? cs.catalog.title };
}

export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const { slug } = await params;
  // Homepage cards (recommendations) + the navigation tree with this category's content and child images.
  const {
    getCategoryBySlug,
    getCategoryTrail,
    getChildCategories,
    getHomepageFeaturedProducts,
    toProductSummary,
  } = await getCatalog(slug);
  const query = await searchParams;
  const filters = parseCategoryFilters(query);
  const requestedPage = Number.parseInt(String(query.page ?? "1"), 10);
  const category = getCategoryBySlug(slug);
  if (!category) notFound();
  const description = categoryDescription(category.description);

  const childCategories = getChildCategories(category.id);
  const hasVisualChildCategories =
    childCategories.length > 0 &&
    childCategories.every(
      (childCategory) => Boolean(childCategory.imageSrc) && Boolean(childCategory.imageAlt),
    );
  const requested = Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1);
  const filtersActive = Boolean(filters.q || filters.min || filters.max || filters.availability);
  // OntOS filters, sorts and pages the whole permitted category server-side (descendants included).
  const listingQuery: CatalogQuery = {
    categorySlug: category.slug,
    pageSize: productsPerPage,
    // parseCategoryFilters already whitelists these values; the casts only narrow `string`.
    sort: filters.sort as CatalogQuery["sort"],
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.minMinor !== undefined ? { minMinor: filters.minMinor } : {}),
    ...(filters.maxMinor !== undefined ? { maxMinor: filters.maxMinor } : {}),
    ...(filters.availability
      ? { availability: filters.availability as "in-stock" | "out-of-stock" }
      : {}),
  };
  let listing = await getCatalogPage({ ...listingQuery, page: requested });
  const lastPage = Math.max(1, Math.ceil(listing.total / productsPerPage));
  if (requested > lastPage && listing.total > 0)
    listing = await getCatalogPage({ ...listingQuery, page: lastPage });
  const { products, total: itemCount } = listing;
  const currentPage = Math.min(requested, lastPage);
  const excludedIds = new Set(products.map((product) => product.id));
  const recommendations = getHomepageFeaturedProducts().filter(
    (product) => !excludedIds.has(product.id),
  );
  const breadcrumbItems = [
    { href: "/", label: cs.header.home },
    ...getCategoryTrail(category).map((item, index, trail) => ({
      href: index === trail.length - 1 ? undefined : `/kategorie/${item.slug}`,
      label: item.name,
    })),
  ];

  const page = (
    <StorefrontShell activeCategorySlug={category.slug}>
      <StorefrontBreadcrumbs items={breadcrumbItems} />
      <section
        className="akros-section akros-product-listing-section"
        aria-labelledby="category-title"
      >
        <div className="akros-category-heading">
          <h1 id="category-title">{category.name}</h1>
          {description && <p>{description}</p>}
        </div>
        {hasVisualChildCategories && <CategoryGrid categories={childCategories} />}
      </section>

      <CategoryFilters
        key={JSON.stringify(filters)}
        filters={filters}
        pathname={`/kategorie/${category.slug}`}
        count={itemCount}
      />
      {itemCount > 0 && products.length > 0 ? (
        <section
          className="akros-section akros-product-listing-section"
          aria-label={`Produkty: ${category.name}`}
        >
          <ProductGrid products={products.map(toProductSummary)} />
          <CatalogPagination
            currentPage={currentPage}
            itemCount={itemCount}
            pageSize={productsPerPage}
            pathname={`/kategorie/${category.slug}`}
            searchParams={categoryFilterParams(filters)}
          />
        </section>
      ) : (
        <p className="akros-empty-state">
          {filtersActive
            ? "Nenalezeny žádné produkty. Upravte nebo vymažte filtry."
            : cs.catalog.emptyCategory}
        </p>
      )}

      {recommendations.length > 0 && (
        <section
          className="akros-section akros-product-listing-section"
          aria-labelledby="recommendations-title"
        >
          <h2 id="recommendations-title">{cs.catalog.recommendations}</h2>
          <ProductGrid products={recommendations.slice(0, 4).map(toProductSummary)} />
        </section>
      )}
    </StorefrontShell>
  );
  // The browser navigation gets only this category branch, not the whole tree.
  return <CategoryBranch activeSlug={category.slug}>{page}</CategoryBranch>;
}
