import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { ProductDetailActions, ProductFavoriteButton } from "@/components/product-detail-actions";
import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import {
  getCategoryById,
  getCategoryTrail,
  getProductBySlug,
  getRecommendedProducts,
  toProductSummary,
} from "@/mock-storefront/catalog";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ variant?: string | string[] }>;
}

const isQuantityPricingCopy = (paragraph: string) =>
  /množstevních slev|snížená cena|snížení ceny/i.test(paragraph);

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = getProductBySlug(slug);

  return { title: product?.name ?? "Produkt" };
}

export default async function ProductPage({ params, searchParams }: ProductPageProps) {
  const { slug } = await params;
  const { variant: requestedVariantSearch } = await searchParams;
  const product = getProductBySlug(slug);
  if (!product) notFound();

  const category = getCategoryById(product.categoryId);
  const categoryTrail = category ? getCategoryTrail(category) : [];
  const detail = product.detail;
  const singleVariant = detail.variants.length === 1 ? detail.variants[0] : undefined;
  const hasMultipleVariants = detail.variants.length > 1;
  const purchaseItem = singleVariant ?? product;
  const purchasePriceTiers = singleVariant?.priceTiers.length
    ? singleVariant.priceTiers
    : detail.priceTiers;
  const basePriceTier =
    purchasePriceTiers.find((tier) => tier.minimumQuantity === purchaseItem.minimumQuantity) ??
    purchasePriceTiers[0];
  const packageQuantity = purchaseItem.packageQuantity ?? purchaseItem.minimumQuantity;
  const availableVariantCount = detail.variants.filter(
    (variant) => variant.stockCount >= variant.minimumQuantity,
  ).length;
  const variantSearch = Array.isArray(requestedVariantSearch)
    ? requestedVariantSearch[0]
    : requestedVariantSearch;
  const normalizedVariantSearch = normalizeCatalogSearchTerm(variantSearch ?? "");
  const initialVariantSearch =
    normalizedVariantSearch &&
    detail.variants.some((variant) => matchesProductVariantSearch(variant, normalizedVariantSearch))
      ? variantSearch?.trim()
      : undefined;
  const productDescriptionParagraphs = detail.descriptionParagraphs.filter(
    (paragraph) => !isQuantityPricingCopy(paragraph),
  );
  const [summaryDescription, ...remainingDescriptionParagraphs] = productDescriptionParagraphs;
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

  const simpleStockLabel =
    purchaseItem.stockCount >= purchaseItem.minimumQuantity
      ? `Skladem ${purchaseItem.stockCount.toLocaleString("cs-CZ")} ${purchaseItem.unit}`
      : purchaseItem.stockCount > 0
        ? `Omezené množství: ${purchaseItem.stockCount.toLocaleString("cs-CZ")} ${purchaseItem.unit}`
        : "Není skladem";
  const stockState =
    purchaseItem.stockCount >= purchaseItem.minimumQuantity
      ? "available"
      : purchaseItem.stockCount > 0
        ? "limited"
        : "unavailable";

  return (
    <StorefrontShell activeCategorySlug={category?.slug}>
      <StorefrontBreadcrumbs
        className="akros-product-detail-breadcrumb"
        items={[
          { href: "/", label: cs.header.home },
          ...categoryTrail.map((item) => ({
            href: `/kategorie/${item.slug}`,
            label: item.name,
          })),
          { label: product.name },
        ]}
      />

      <article className="akros-product-detail">
        <section className="akros-product-detail__overview" aria-labelledby="product-title">
          <div className="akros-product-detail__gallery">
            <Image
              alt={product.imageAlt}
              className="akros-product-detail__image akros-product-detail__image--primary"
              height={824}
              priority
              sizes="(max-width: 760px) 100vw, 50vw"
              src={product.imageSrc}
              width={1000}
            />
            {product.secondaryImageSrc && (
              <div className="akros-product-detail__thumbnails">
                <Image
                  alt={`Technický nákres: ${product.name}`}
                  className="akros-product-detail__image akros-product-detail__image--thumbnail"
                  height={244}
                  loading="lazy"
                  sizes="148px"
                  src={product.secondaryImageSrc}
                  width={296}
                />
              </div>
            )}
          </div>

          <div className="akros-product-detail__summary">
            <header className="akros-product-detail__heading">
              <h1 id="product-title">{product.name}</h1>
              {hasMultipleVariants && (
                <Badge
                  className="akros-product-detail__variant-badge"
                  size="md"
                  variant="secondary"
                >
                  Více variant
                </Badge>
              )}
              {singleVariant && (
                <Badge
                  className="akros-product-detail__variant-badge"
                  size="md"
                  variant="secondary"
                >
                  Jedna varianta
                </Badge>
              )}
            </header>

            {summaryDescription && (
              <p className="akros-product-detail__description">{summaryDescription}</p>
            )}

            <dl className="akros-product-detail__facts">
              {packageQuantity > purchaseItem.minimumQuantity && (
                <div>
                  <dt>Počet v balení</dt>
                  <dd>
                    {packageQuantity.toLocaleString("cs-CZ")} {purchaseItem.unit}
                  </dd>
                </div>
              )}
              <div>
                <dt>Kód produktu</dt>
                <dd>{purchaseItem.sku}</dd>
              </div>
              {product.netWeight && (
                <div>
                  <dt>Váha</dt>
                  <dd>
                    {product.netWeight.toLocaleString("cs-CZ", {
                      maximumFractionDigits: 6,
                    })}
                  </dd>
                </div>
              )}
              <div>
                <dt>Měrná jednotka</dt>
                <dd>{purchaseItem.unit}</dd>
              </div>
              {purchaseItem.minimumQuantity > 1 && (
                <div>
                  <dt>Minimální odběr</dt>
                  <dd>
                    {purchaseItem.minimumQuantity.toLocaleString("cs-CZ")} {purchaseItem.unit}
                  </dd>
                </div>
              )}
              {hasMultipleVariants && (
                <div>
                  <dt>Počet variant</dt>
                  <dd>{detail.variants.length.toLocaleString("cs-CZ")}</dd>
                </div>
              )}
            </dl>

            {hasMultipleVariants ? (
              <p
                className={`akros-product-detail__stock${availableVariantCount > 0 ? "" : " akros-product-detail__stock--unavailable"}`}
              >
                {availableVariantCount > 0
                  ? `Skladem ${availableVariantCount.toLocaleString("cs-CZ")} z ${detail.variants.length.toLocaleString("cs-CZ")} variant`
                  : "Momentálně není skladem žádná varianta"}
              </p>
            ) : (
              <>
                <p
                  className={`akros-product-detail__stock akros-product-detail__stock--${stockState}`}
                >
                  {simpleStockLabel}
                </p>

                <div className="akros-product-detail__buying">
                  {purchasePriceTiers.length > 1 && (
                    <dl className="akros-price-tiers" aria-label={cs.product.quantityPricing}>
                      {purchasePriceTiers.map((tier) => (
                        <div key={tier.minimumQuantity}>
                          <dt>
                            od {tier.minimumQuantity.toLocaleString("cs-CZ")} {purchaseItem.unit}
                          </dt>
                          <dd>{formatPrice(tier.priceMinor, product.currency)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {basePriceTier && (
                    <p className="akros-product-detail__price-row">
                      <span>Cena bez DPH</span>
                      <strong>{formatPrice(basePriceTier.priceExcludingVatMinor)}</strong>
                    </p>
                  )}
                  <p className="akros-product-detail__price-row akros-product-detail__price-row--total">
                    <span>Cena s DPH</span>
                    <strong>{formatPrice(purchaseItem.priceMinor, product.currency)}</strong>
                  </p>

                  <div className="akros-product-detail__purchase-row">
                    <ProductPurchaseForm product={product} variant={singleVariant} />
                    <ProductFavoriteButton productId={product.id} productName={product.name} />
                  </div>
                </div>
              </>
            )}

            <ProductDetailActions productId={product.id} productName={product.name} />
          </div>
        </section>

        {(remainingDescriptionParagraphs.length > 0 || detail.parameters.length > 0) && (
          <section className="akros-product-detail__surface" aria-labelledby="description-title">
            <h2 id="description-title">{cs.product.details}</h2>
            {remainingDescriptionParagraphs.map((paragraph) => (
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

        {hasMultipleVariants && (
          <section id="product-variants" aria-label="Varianty produktu">
            <ProductPurchaseForm
              initialVariantSearch={initialVariantSearch}
              product={product}
              variants={detail.variants}
            />
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
