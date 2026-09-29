import type { Metadata } from "next";
import Image from "next/image";
import NextLink from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@techsio/ui-kit/atoms/button";

import { ProductDetailActions } from "@/components/product-detail-actions";
import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import {
  getCategoryById,
  getCategoryTrail,
  getProductBySlug,
  getRecommendedProducts,
  toProductSummary,
} from "@/mock-storefront/catalog";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
}

const isQuantityPricingCopy = (paragraph: string) =>
  /množstevních slev|snížená cena|snížení ceny/i.test(paragraph);

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
  const hasVariants = detail.variants.length > 0;
  const quantityPricingParagraphs = detail.descriptionParagraphs
    .filter(isQuantityPricingCopy)
    .flatMap((paragraph) => paragraph.split(/(?=Snížená cena)/i))
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const productDescriptionParagraphs = detail.descriptionParagraphs.filter(
    (paragraph) => !isQuantityPricingCopy(paragraph),
  );
  const materialMarkers = product.name.match(/\bA[1-5]\b|\b1\.\d{4}\b/gi) ?? [];
  const recommendationScore = (candidateName: string) =>
    materialMarkers.filter((marker) =>
      candidateName.toLocaleUpperCase("cs-CZ").includes(marker.toLocaleUpperCase("cs-CZ")),
    ).length;
  const recommendations = getRecommendedProducts()
    .filter(
      (candidate) =>
        candidate.id !== product.id &&
        candidate.name.trim().toLocaleUpperCase("cs-CZ") !== "AKCE" &&
        candidate.priceMinor > 0 &&
        candidate.imageSrc !== "/akros/products/image-unavailable.svg",
    )
    .sort(
      (left, right) =>
        recommendationScore(right.name) - recommendationScore(left.name) ||
        left.name.localeCompare(right.name, "cs"),
    )
    .slice(0, 3);

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
          <h1>{product.name}</h1>
        </header>

        <div className="akros-product-detail__lead">
          <div className="akros-product-detail__gallery">
            <Image
              alt={product.imageAlt}
              className="akros-product-detail__image akros-product-detail__image--primary"
              height={840}
              priority
              sizes="(max-width: 760px) 100vw, 500px"
              src={product.imageSrc}
              width={1000}
            />
            {product.secondaryImageSrc && (
              <Image
                alt={`Technický nákres: ${product.name}`}
                className="akros-product-detail__image akros-product-detail__image--drawing"
                height={180}
                loading="lazy"
                sizes="(max-width: 760px) 100vw, 500px"
                src={product.secondaryImageSrc}
                width={1000}
              />
            )}
          </div>

          {hasVariants ? (
            <aside
              className="akros-product-detail__surface akros-product-detail__sales"
              aria-label={cs.product.productActions}
            >
              <h2>Máte IČO? Chcete lepší cenu? Zavolejte mi!</h2>
              {quantityPricingParagraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <NextLink
                className={buttonVariants({ block: true, size: "lg", variant: "primary" })}
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
              <ProductPurchaseForm product={product} />
            </aside>
          )}
        </div>

        {detail.priceTiers.length > 1 && (
          <section
            className="akros-product-detail__surface"
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

        {hasVariants && <ProductDetailActions productId={product.id} productName={product.name} />}

        {(productDescriptionParagraphs.length > 0 || detail.parameters.length > 0) && (
          <section className="akros-product-detail__surface" aria-labelledby="description-title">
            <h2 id="description-title">{cs.product.details}</h2>
            {productDescriptionParagraphs.map((paragraph) => (
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
          <section id="product-variants" aria-label="Varianty produktu">
            <ProductPurchaseForm product={product} variants={detail.variants} />
          </section>
        )}

        {recommendations.length > 0 && (
          <section
            className="akros-product-detail__surface akros-section akros-section--product-recommendations"
            aria-labelledby="product-recommendations-title"
          >
            <h2 id="product-recommendations-title">{cs.catalog.recommendations}</h2>
            <ProductGrid action="detail" products={recommendations.map(toProductSummary)} />
          </section>
        )}
      </article>
    </StorefrontShell>
  );
}
