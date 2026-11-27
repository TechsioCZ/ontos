import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Schema } from "effect";
import { getDictionary } from "@/i18n";
import { getCatalog } from "@/ontos/catalog";
import { categoryTrail } from "@/ontos/catalog-navigation";
import { ProductView } from "@/features/product-view";
import { CatalogState } from "@/features/catalog-state";
import { CatalogView } from "@/features/catalog-view";

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> => {
  const { locale, slug } = await params;
  const result = await getCatalog(locale, JSON.stringify({ slug }));
  const product =
    result.state === "ready"
      ? result.catalog.details.find((item) => item.slug === slug)
      : undefined;
  if (product === undefined) {
    return {};
  }
  const title = product.seoTitle || product.name;
  const description = product.seoDescription || product.paragraphs[0] || product.description;
  const [image] = product.images;
  const openGraph: NonNullable<Metadata["openGraph"]> = { title };
  const metadata: Metadata = { openGraph, title };
  if (description.length > 0) {
    metadata.description = description;
    openGraph.description = description;
  }
  if (image !== undefined) {
    openGraph.images = [image];
  }
  return metadata;
};

const ProductPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ variantId?: string | string[] }>;
}) => {
  const { locale, slug } = await params;
  const d = getDictionary(locale);
  // The product read carries no category tree: the layout's featured read (same render, same cache) has it.
  const [result, navigation] = await Promise.all([
    getCatalog(locale, JSON.stringify({ slug })),
    getCatalog(locale, JSON.stringify({ featured: true })),
  ]);
  if (result.state === "unavailable") {
    return <CatalogState kind="product" />;
  }
  if (!result.catalog.configured) {
    return <output className="block p-8">{d.offerMissing}</output>;
  }
  const product = result.catalog.details.find((item) => item.slug === slug);
  if (!product) {
    notFound();
  }
  const search = await searchParams;
  if (Array.isArray(search.variantId)) {
    notFound();
  }
  const variantId = Schema.is(Schema.String)(search.variantId) ? search.variantId : undefined;
  // Historical N1 recommends by category. The current public owner read supports
  // one category, so use the actual primary category, never an unfiltered fallback.
  const categories = navigation.state === "ready" ? navigation.catalog.categories : [];
  const category = categories.find((item) => item.id === product.categoryId);
  // The browser gets only the breadcrumb trail, not the whole category tree.
  const trail = category === undefined ? [] : categoryTrail(categories, category.slug);
  let related: Awaited<ReturnType<typeof getCatalog>> | undefined;
  if (product.relatedProductIds.length > 0) {
    related = await getCatalog(
      locale,
      JSON.stringify({ productIds: product.relatedProductIds.slice(0, 24) }),
    );
  } else if (category !== undefined) {
    related = await getCatalog(locale, JSON.stringify({ categorySlug: category.slug }));
  }
  const relatedLimit = product.relatedProductIds.length > 0 ? 24 : 4;
  const relatedCatalog =
    related?.state === "ready"
      ? {
          ...related,
          catalog: {
            ...related.catalog,
            categories: [],
            details: [],
            products: related.catalog.products
              .filter((item) => item.id !== product.id)
              .slice(0, relatedLimit),
          },
        }
      : related;
  return (
    <>
      <ProductView
        categories={trail}
        dictionary={d}
        key={`${product.id}:${variantId ?? ""}`}
        locale={locale}
        product={product}
        {...(variantId === undefined ? {} : { variantId })}
      />
      {relatedCatalog !== undefined && (
        <section
          aria-labelledby="product-related-heading"
          className="mx-auto mb-4 mt-4 flex max-w-n1-product-content flex-col gap-8 px-4 md:mt-0 md:gap-0"
        >
          <h2
            className="text-xl font-semibold leading-9 md:text-n1-product-section md:font-bold md:leading-7 md:uppercase"
            id="product-related-heading"
          >
            {d.relatedProducts}
          </h2>
          {relatedCatalog.state === "ready" ? (
            <CatalogView
              catalog={relatedCatalog.catalog}
              dictionary={d}
              locale={locale}
              presentation="related"
              title={d.relatedProducts}
            />
          ) : (
            <p className="text-md leading-6 text-fg-secondary">{d.categoryLoadFailed}</p>
          )}
        </section>
      )}
    </>
  );
};

export default ProductPage;
