import { notFound } from "next/navigation";
import { Schema } from "effect";
import { getDictionary } from "@/i18n";
import { getCatalog } from "@/ontos/catalog";
import { ProductView } from "@/features/product-view";
import { CatalogState } from "@/features/catalog-state";

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
  const variantId = Schema.is(Schema.String)(search.variantId) ? search.variantId : undefined;
  return (
    <ProductView
      categories={result.catalog.categories}
      dictionary={d}
      key={`${product.id}:${variantId ?? ""}`}
      locale={locale}
      product={product}
      {...(variantId === undefined ? {} : { variantId })}
    />
  );
};

export default ProductPage;
