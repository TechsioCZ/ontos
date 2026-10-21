import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CategoryGrid } from "@/components/category-grid";
import { CategoryFilters } from "@/components/category-filters";
import { isOntos } from "@/ontos/config";
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
import type { CatalogProduct } from "@/mock-storefront/types";
import { categoryDescription } from "@/lib/category-presentation";

interface CategoryPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<CategoryQuery>;
}

const productsPerPage = 24;

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const {
    getCategoryBySlug,
    getCategoryTrail,
    getChildCategories,
    getFeaturedProducts,
    getProductsByCategory,
    toProductSummary,
  } = await getCatalog();
  const { slug } = await params;
  const category = getCategoryBySlug(slug);

  return { title: category?.name ?? cs.catalog.title };
}

export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const {
    getCategoryBySlug,
    getCategoryTrail,
    getChildCategories,
    getFeaturedProducts,
    getHomepageFeaturedProducts,
    getProductsByCategory,
    toProductSummary,
  } = await getCatalog();
  const { slug } = await params;
  const query = await searchParams;
  const ontos = isOntos();
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
  const filtersActive =
    ontos && Boolean(filters.q || filters.min || filters.max || filters.availability);
  let products: CatalogProduct[];
  let itemCount: number;
  let currentPage: number;
  let excludedIds: Set<string>;
  if (ontos) {
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
    products = listing.products;
    itemCount = listing.total;
    currentPage = Math.min(requested, lastPage);
    excludedIds = new Set(products.map((product) => product.id));
  } else {
    const categoryProducts = getProductsByCategory(category.slug);
    itemCount = categoryProducts.length;
    const totalPages = Math.max(1, Math.ceil(itemCount / productsPerPage));
    currentPage = Math.min(requested, totalPages);
    products = categoryProducts.slice(
      (currentPage - 1) * productsPerPage,
      currentPage * productsPerPage,
    );
    excludedIds = new Set(categoryProducts.map((product) => product.id));
  }
  const recommendations = (ontos ? getHomepageFeaturedProducts() : getFeaturedProducts()).filter(
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

      {ontos && (
        <CategoryFilters
          key={JSON.stringify(filters)}
          filters={filters}
          pathname={`/kategorie/${category.slug}`}
          count={itemCount}
        />
      )}
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
            searchParams={ontos ? categoryFilterParams(filters) : undefined}
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
  // OntOS mode: the browser navigation gets only this category branch, not the whole tree.
  return <CategoryBranch activeSlug={category.slug}>{page}</CategoryBranch>;
}
