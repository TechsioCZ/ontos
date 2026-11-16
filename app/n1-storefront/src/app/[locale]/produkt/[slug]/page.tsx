import { notFound } from "next/navigation";
import { Schema } from "effect";
import { getDictionary } from "@/i18n";
import { getCatalog } from "@/ontos/catalog";
import { ProductView } from "@/features/product-view";
import { CatalogState } from "@/features/catalog-state";
import { CatalogView } from "@/features/catalog-view";

const ProductPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ variantId?: string | string[] }>;
}) => {
  const { locale, slug } = await params;
  const d = getDictionary(locale);
  const result = await getCatalog(locale, JSON.stringify({ slug }));
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
  const category = result.catalog.categories.find((item) => item.id === product.categoryId);
  const related =
    category === undefined
      ? undefined
      : await getCatalog(locale, JSON.stringify({ categorySlug: category.slug }));
  const relatedCatalog =
    related?.state === "ready"
      ? {
          ...related,
          catalog: {
            ...related.catalog,
            details: [],
            products: related.catalog.products.filter((item) => item.id !== product.id).slice(0, 4),
          },
        }
      : related;
  return (
    <>
      <ProductView
        categories={result.catalog.categories}
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
