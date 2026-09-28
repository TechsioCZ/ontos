import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CategoryGrid } from "@/components/category-grid";
import { CatalogPagination } from "@/components/catalog-pagination";
import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { cs } from "@/i18n/cs";
import {
  getCategoryBySlug,
  getCategoryTrail,
  getChildCategories,
  getFeaturedProducts,
  getProductsByCategory,
  toProductSummary,
} from "@/mock-storefront/catalog";

interface CategoryPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}

const productsPerPage = 24;

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = getCategoryBySlug(slug);

  return { title: category?.name ?? cs.catalog.title };
}

export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const { slug } = await params;
  const requestedPage = Number.parseInt((await searchParams).page ?? "1", 10);
  const category = getCategoryBySlug(slug);
  if (!category) notFound();

  const childCategories = getChildCategories(category.id);
  const products = getProductsByCategory(category.slug);
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
      <section className="akros-section" aria-labelledby="category-title">
        <div className="akros-category-heading">
          <h1 id="category-title">{category.name}</h1>
          <p>{category.description || cs.catalog.categoryDescription}</p>
        </div>
        <CategoryGrid categories={childCategories} />
      </section>

      {products.length > 0 ? (
        <section className="akros-section" aria-label={`Produkty: ${category.name}`}>
          <ProductGrid products={visibleProducts.map(toProductSummary)} />
          <CatalogPagination
            currentPage={currentPage}
            hrefForPage={(page) => `/kategorie/${category.slug}?page=${page}`}
            totalPages={totalPages}
          />
        </section>
      ) : (
        <p className="akros-empty-state">{cs.catalog.emptyCategory}</p>
      )}

      {recommendations.length > 0 && (
        <section className="akros-section" aria-labelledby="recommendations-title">
          <h2 id="recommendations-title">{cs.catalog.recommendations}</h2>
          <ProductGrid products={recommendations.slice(0, 4).map(toProductSummary)} />
        </section>
      )}
    </StorefrontShell>
  );
}
