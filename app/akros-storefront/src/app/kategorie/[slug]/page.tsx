import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CategoryGrid } from "@/components/category-grid";
import { CategoryFilters } from "@/components/category-filters";
import { isOntos } from "@/ontos/config";
import {
  parseCategoryFilters,
  categoryFilterParams,
  filterCategoryProducts,
  type CategoryQuery,
} from "@/ontos/category-filters";
import { CatalogPagination } from "@/components/catalog-pagination";
import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import { getCatalog } from "@/ontos/catalog-server";

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

  const childCategories = getChildCategories(category.id);
  const hasVisualChildCategories =
    childCategories.length > 0 &&
    childCategories.every(
      (childCategory) => Boolean(childCategory.imageSrc) && Boolean(childCategory.imageAlt),
    );
  const categoryProducts = getProductsByCategory(category.slug);
  const products = ontos ? filterCategoryProducts(categoryProducts, filters) : categoryProducts;
  const totalPages = Math.max(1, Math.ceil(products.length / productsPerPage));
  const currentPage = Math.min(
    Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1),
    totalPages,
  );
  const visibleProducts = products.slice(
    (currentPage - 1) * productsPerPage,
    currentPage * productsPerPage,
  );
  const recommendations = getFeaturedProducts().filter(
    (product) => !products.some((categoryProduct) => categoryProduct.id === product.id),
  );
  const breadcrumbItems = [
    { href: "/", label: cs.header.home },
    ...getCategoryTrail(category).map((item, index, trail) => ({
      href: index === trail.length - 1 ? undefined : `/kategorie/${item.slug}`,
      label: item.name,
    })),
  ];

  return (
    <StorefrontShell activeCategorySlug={category.slug}>
      <StorefrontBreadcrumbs items={breadcrumbItems} />
      <section
        className="akros-section akros-product-listing-section"
        aria-labelledby="category-title"
      >
        <div className="akros-category-heading">
          <h1 id="category-title">{category.name}</h1>
          {category.description && <p>{category.description}</p>}
        </div>
        {hasVisualChildCategories && <CategoryGrid categories={childCategories} />}
      </section>

      {ontos && (
        <CategoryFilters
          key={JSON.stringify(filters)}
          filters={filters}
          pathname={`/kategorie/${category.slug}`}
          count={products.length}
        />
      )}
      {products.length > 0 ? (
        <section
          className="akros-section akros-product-listing-section"
          aria-label={`Produkty: ${category.name}`}
        >
          <ProductGrid products={visibleProducts.map(toProductSummary)} />
          <CatalogPagination
            currentPage={currentPage}
            itemCount={products.length}
            pageSize={productsPerPage}
            pathname={`/kategorie/${category.slug}`}
            searchParams={ontos ? categoryFilterParams(filters) : undefined}
          />
        </section>
      ) : (
        <p className="akros-empty-state">
          {ontos && categoryProducts.length
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
}
