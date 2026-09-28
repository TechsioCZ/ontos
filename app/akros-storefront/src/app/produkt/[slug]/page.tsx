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
  getProductById,
  getProductBySlug,
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
  const recommendations = detail
    ? detail.recommendationProductIds.flatMap((productId) => {
        const recommendation = getProductById(productId);
        return recommendation ? [recommendation] : [];
      })
    : getFeaturedProducts()
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

      <article className={`akros-product-detail${detail ? " akros-product-detail--variants" : ""}`}>
        <header className="akros-product-detail__heading">
          {!detail && (
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
              loading="eager"
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

          {detail ? (
            <aside className="akros-product-detail__sales" aria-label={cs.product.productActions}>
              <h2>{detail.salesHeading}</h2>
              {detail.salesCopy.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <NextLink
                className={buttonVariants({ size: "lg", variant: "primary" })}
                href="#product-variants"
              >
                Prosím vyberte variantu
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
              <p>{product.description}</p>
              <ProductPurchaseForm productId={product.id} />
            </aside>
          )}
        </div>

        <section className="akros-product-detail__section" aria-labelledby="quantity-pricing-title">
          <h2 id="quantity-pricing-title">{cs.product.quantityPricing}</h2>
          <p>
            {detail
              ? "Ceny jsou uvedeny bez DPH. Slevy se aplikují automaticky při vložení zboží do košíku."
              : "Ceny jsou uvedeny za jeden kus. Sleva se přepočítá podle zvoleného množství."}
          </p>
          <dl className="akros-price-tiers">
            {(
              detail?.quantityTiers ?? [
                { label: `1–99 ${product.unit}`, priceMinor: product.priceMinor },
                {
                  label: `100–499 ${product.unit}`,
                  priceMinor: Math.round(product.priceMinor * 0.96),
                },
                {
                  label: `500–999 ${product.unit}`,
                  priceMinor: Math.round(product.priceMinor * 0.92),
                },
                { label: "1 000 a více", priceMinor: Math.round(product.priceMinor * 0.88) },
              ]
            ).map((tier) => (
              <div key={tier.label}>
                <dt>{tier.label}</dt>
                <dd>{formatPrice(tier.priceMinor)}</dd>
              </div>
            ))}
          </dl>
        </section>

        {detail && (
          <section
            className="akros-product-detail__section"
            aria-labelledby="product-actions-title"
          >
            <h2 id="product-actions-title">{cs.product.productActions}</h2>
            <div className="akros-product-actions">
              <NextLink
                className={buttonVariants({ size: "lg", variant: "primary" })}
                href="#product-variants"
              >
                {detail.actions[0]}
              </NextLink>
              <NextLink
                className={buttonVariants({ size: "lg", variant: "primary" })}
                href="/prihlaseni"
              >
                {detail.actions[1]}
              </NextLink>
              <NextLink
                className={buttonVariants({ size: "lg", variant: "primary" })}
                href="?print=1"
              >
                {detail.actions[2]}
              </NextLink>
              <NextLink
                className={buttonVariants({ size: "lg", variant: "primary" })}
                href="mailto:akros@akros.cz"
              >
                {detail.actions[3]}
              </NextLink>
              <NextLink
                className={buttonVariants({ size: "lg", variant: "primary" })}
                href={`mailto:?subject=${encodeURIComponent(product.name)}`}
              >
                {detail.actions[4]}
              </NextLink>
            </div>
          </section>
        )}

        <section className="akros-product-detail__section" aria-labelledby="description-title">
          <h2 id="description-title">{cs.product.details}</h2>
          {detail ? (
            <>
              {detail.descriptionParagraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <p>Parametry:</p>
              <ul className="akros-product-parameters">
                {detail.parameters.map((parameter) => (
                  <li key={parameter.label}>
                    {parameter.label}: {parameter.value}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>{product.description}</p>
          )}
        </section>

        {detail && (
          <section
            className="akros-product-detail__section"
            id="product-variants"
            aria-labelledby="product-variants-title"
          >
            <h2 id="product-variants-title">Vyhledání variant</h2>
            <ProductPurchaseForm productId={product.id} variants={detail.variants} />
          </section>
        )}
      </article>

      {recommendations.length > 0 && (
        <section
          className={`akros-section${detail ? " akros-section--product-recommendations" : ""}`}
          aria-labelledby="product-recommendations-title"
        >
          <h2 id="product-recommendations-title">{cs.catalog.recommendations}</h2>
          <ProductGrid action={detail ? "detail" : "purchase"} products={recommendations} />
        </section>
      )}
    </StorefrontShell>
  );
}
