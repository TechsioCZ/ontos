import type { Metadata } from "next";
import Image from "next/image";
import NextLink from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@techsio/ui-kit/atoms/button";

import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import {
  getCategoryById,
  getCategoryTrail,
  getFeaturedProducts,
  getProductBySlug,
  toProductSummary,
} from "@/mock-storefront/catalog";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = getProductBySlug(slug);

  return { title: product?.name ?? "Produkt" };
}

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params;
  const product = getProductBySlug(slug);
  if (!product) notFound();

  const category = getCategoryById(product.categoryId);
  const categoryTrail = category ? getCategoryTrail(category) : [];
  const detail = product.detail;
  const hasVariants = detail?.variants.length > 0;
  const recommendations = getFeaturedProducts()
    .filter((candidate) => candidate.id !== product.id)
    .slice(0, 4);

  return (
    <StorefrontShell activeCategorySlug={category?.slug}>
      <StorefrontBreadcrumbs
        items={[
          { href: "/", label: cs.header.home },
          ...categoryTrail.map((item) => ({
            href: `/kategorie/${item.slug}`,
            label: item.name,
          })),
          { label: product.name },
        ]}
      />

      <article
        className={`akros-product-detail${hasVariants ? " akros-product-detail--variants" : ""}`}
      >
        <header className="akros-product-detail__heading">
          {product.sku && (
            <p>
              {cs.product.sku}: {product.sku}
            </p>
          )}
          <h1>{product.name}</h1>
        </header>

        <div className="akros-product-detail__lead">
          <div className="akros-product-detail__gallery">
            <Image
              alt={product.imageAlt}
              className="akros-product-detail__image akros-product-detail__image--primary"
              height={620}
              priority
              sizes="(max-width: 760px) 100vw, 42vw"
              src={product.imageSrc}
              width={620}
            />
            {product.secondaryImageSrc && (
              <Image
                alt={`Technický nákres: ${product.name}`}
                className="akros-product-detail__image akros-product-detail__image--drawing"
                height={180}
                loading="lazy"
                src={product.secondaryImageSrc}
                width={620}
              />
            )}
          </div>

          {hasVariants ? (
            <aside className="akros-product-detail__sales" aria-label={cs.product.productActions}>
              <h2>Vyberte konkrétní variantu</h2>
              <p>
                {product.priceMinor > 0
                  ? `Cena od ${formatPrice(product.priceMinor, product.currency)} / ${product.unit}`
                  : "Cena vybraných variant je na dotaz"}
              </p>
              <p>
                Celkem skladem: {product.stockCount.toLocaleString("cs-CZ")} {product.unit}
              </p>
              <NextLink
                className={buttonVariants({ size: "lg", variant: "primary" })}
                href="#product-variants"
              >
                Zobrazit varianty
              </NextLink>
            </aside>
          ) : (
            <aside className="akros-product-detail__order" aria-label={cs.product.productActions}>
              <p className="akros-product-detail__stock">
                {cs.product.inStock}:{" "}
                <strong>
                  {product.stockCount.toLocaleString("cs-CZ")} {product.unit}
                </strong>
              </p>
              <p className="akros-product-detail__price">
                {formatPrice(product.priceMinor, product.currency)} <span>/ {product.unit}</span>
              </p>
              {product.description && <p>{product.description}</p>}
              <ProductPurchaseForm product={product} />
            </aside>
          )}
        </div>

        {detail.priceTiers.length > 0 && !hasVariants && (
          <section
            className="akros-product-detail__section"
            aria-labelledby="quantity-pricing-title"
          >
            <h2 id="quantity-pricing-title">{cs.product.quantityPricing}</h2>
            <dl className="akros-price-tiers">
              {detail.priceTiers.map((tier) => (
                <div key={tier.minimumQuantity}>
                  <dt>
                    od {tier.minimumQuantity.toLocaleString("cs-CZ")} {product.unit}
                  </dt>
                  <dd>{formatPrice(tier.priceMinor)}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {(detail.descriptionParagraphs.length > 0 || detail.parameters.length > 0) && (
          <section className="akros-product-detail__section" aria-labelledby="description-title">
            <h2 id="description-title">{cs.product.details}</h2>
            {detail.descriptionParagraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {detail.parameters.length > 0 && (
              <ul className="akros-product-parameters">
                {detail.parameters.map((parameter) => (
                  <li key={parameter.label}>
                    {parameter.label}: {parameter.value}
                    {parameter.unit && ` ${parameter.unit}`}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {hasVariants && (
          <section
            className="akros-product-detail__section"
            id="product-variants"
            aria-labelledby="product-variants-title"
          >
            <h2 id="product-variants-title">Varianty produktu</h2>
            <ProductPurchaseForm product={product} variants={detail.variants} />
          </section>
        )}
      </article>

      {recommendations.length > 0 && (
        <section className="akros-section" aria-labelledby="product-recommendations-title">
          <h2 id="product-recommendations-title">{cs.catalog.recommendations}</h2>
          <ProductGrid action="detail" products={recommendations.map(toProductSummary)} />
        </section>
      )}
    </StorefrontShell>
  );
}
