import { notFound } from "next/navigation";
import { getDictionary } from "@/i18n";
import { getCatalog } from "@/ontos/catalog";
import { CategoryView } from "@/features/category-view";
import { catalogPage } from "@/ontos/catalog-navigation";
import { CatalogState } from "@/features/catalog-state";

const CategoryPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) => {
  const { locale, slug } = await params;
  const d = getDictionary(locale);
  const search = await searchParams;
  const result = await getCatalog(
    locale,
    JSON.stringify({ categorySlug: slug, page: catalogPage(search.page) }),
  );
  if (result.state === "unavailable") {
    return <CatalogState kind="category" />;
  }
  const category = result.catalog.categories.find((item) => item.slug === slug);
  if (!category && result.catalog.configured) {
    notFound();
  }
  return <CategoryView catalog={result.catalog} dictionary={d} locale={locale} slug={slug} />;
};

export default CategoryPage;
