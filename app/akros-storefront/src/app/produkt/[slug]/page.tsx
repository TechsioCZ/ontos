import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { ProductDetailActions, ProductFavoriteButton } from "@/components/product-detail-actions";
import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { CategoryBranch } from "@/ontos/category-branch";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { formatPrice } from "@/lib/format";
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import { getDictionary, getMoney } from "@/ontos/active-market";
import { getCatalog, getCatalogPage } from "@/ontos/catalog-server";
import { purchaseProductOf, purchaseVariantOf } from "@/ontos/catalog-projection";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ variant?: string | string[] }>;
}

const isQuantityPricingCopy = (paragraph: string) =>
  /množstevních slev|snížená cena|snížení ceny/i.test(paragraph);

/** The one `full` read: this product with its variants, parameters and description. */
const getProductDetail = async (slug: string) =>
  (await getCatalogPage({ slug, pageSize: 1 }, { fields: "full" })).model;

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  const [product, cs] = await Promise.all([
    getProductDetail(slug).then((catalog) => catalog.getProductBySlug(slug)),
    getDictionary(),
  ]);

  return { title: product?.name ?? cs.product.title };
}

export default async function ProductPage({ params, searchParams }: ProductPageProps) {
  const { slug } = await params;
  // Recommendations come from the homepage selection (cards), read alongside the product detail.
  const [
    featuredCatalog,
    { getCategoryById, getCategoryTrail, getProductBySlug, toProductSummary },
    cs,
    money,
  ] = await Promise.all([getCatalog(), getProductDetail(slug), getDictionary(), getMoney()]);
  const { variant: requestedVariantSearch } = await searchParams;
  const product = getProductBySlug(slug);
  if (!product) notFound();

  const category = getCategoryById(product.categoryId);
  const categoryTrail = category ? getCategoryTrail(category) : [];
  const detail = product.detail;
  const purchaseProduct = purchaseProductOf(product);
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
    (variant) => !variant.availabilityUnknown && variant.stockCount >= variant.minimumQuantity,
  ).length;
  const unknownVariantCount = detail.variants.filter(
    (variant) => variant.availabilityUnknown,
  ).length;
  const number = (value: number, maximumFractionDigits = 0) =>
    value.toLocaleString(money.locale, { maximumFractionDigits });
  const priceUnavailableReason =
    purchaseItem.priceUnavailableReason ??
    (purchaseItem.priceMinor > 0 ? undefined : cs.product.noValidPrice);
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
  const recommendations = featuredCatalog
    .getHomepageFeaturedProducts()
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

  const simpleStockLabel = purchaseItem.availabilityUnknown
    ? cs.product.availabilityNowUnknown
    : purchaseItem.stockCount >= purchaseItem.minimumQuantity
      ? cs.product.inStockCount(purchaseItem.stockCount, purchaseItem.unit)
      : purchaseItem.stockCount > 0
        ? cs.product.limitedStockCount(purchaseItem.stockCount, purchaseItem.unit)
        : cs.product.outOfStock;
  const stockState = purchaseItem.availabilityUnknown
    ? "limited"
    : purchaseItem.stockCount >= purchaseItem.minimumQuantity
      ? "available"
      : purchaseItem.stockCount > 0
        ? "limited"
        : "unavailable";

  const page = (
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
            {product.additionalImageSrcs?.length ? (
              <div className="akros-product-detail__thumbnails">
                {product.additionalImageSrcs.map((src, index) => (
                  <Image
                    alt={`${product.name} – ${cs.product.imageNumber(index + 2)}`}
                    className="akros-product-detail__image akros-product-detail__image--thumbnail"
                    height={244}
                    key={src}
                    loading="lazy"
                    sizes="148px"
                    src={src}
                    width={296}
                  />
                ))}
              </div>
            ) : (
              product.secondaryImageSrc && (
                <div className="akros-product-detail__thumbnails">
                  <Image
                    alt={cs.product.technicalDrawing(product.name)}
                    className="akros-product-detail__image akros-product-detail__image--thumbnail"
                    height={244}
                    loading="lazy"
                    sizes="148px"
                    src={product.secondaryImageSrc}
                    width={296}
                  />
                </div>
              )
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
                  {cs.product.moreVariants}
                </Badge>
              )}
              {singleVariant && (
                <Badge
                  className="akros-product-detail__variant-badge"
                  size="md"
                  variant="secondary"
                >
                  {cs.product.oneVariant}
                </Badge>
              )}
            </header>

            {summaryDescription && (
              <p className="akros-product-detail__description">{summaryDescription}</p>
            )}

            <dl className="akros-product-detail__facts">
              {packageQuantity > purchaseItem.minimumQuantity && (
                <div>
                  <dt>{cs.product.packageQuantity}</dt>
                  <dd>
                    {number(packageQuantity)} {purchaseItem.unit}
                  </dd>
                </div>
              )}
              <div>
                <dt>{cs.product.sku}</dt>
                <dd>{purchaseItem.sku}</dd>
              </div>
              {product.netWeight && (
                <div>
                  <dt>{cs.product.netWeight}</dt>
                  <dd>{number(product.netWeight, 6)}</dd>
                </div>
              )}
              <div>
                <dt>{cs.product.measurementUnit}</dt>
                <dd>{purchaseItem.unit}</dd>
              </div>
              {purchaseItem.minimumQuantity > 1 && (
                <div>
                  <dt>{cs.product.minimumOrder}</dt>
                  <dd>
                    {hasMultipleVariants && product.quantityStep
                      ? cs.product.minimumOrderByVariant
                      : `${number(purchaseItem.minimumQuantity)} ${purchaseItem.unit}`}
                  </dd>
                </div>
              )}
              {hasMultipleVariants && (
                <div>
                  <dt>{cs.product.variantCount}</dt>
                  <dd>{number(detail.variants.length)}</dd>
                </div>
              )}
            </dl>

            {hasMultipleVariants ? (
              <p
                className={`akros-product-detail__stock${availableVariantCount > 0 ? "" : " akros-product-detail__stock--unavailable"}`}
              >
                {availableVariantCount > 0
                  ? cs.product.variantsInStock(availableVariantCount, detail.variants.length)
                  : unknownVariantCount > 0
                    ? cs.product.variantsUnknown
                    : cs.product.variantsOutOfStock}
              </p>
            ) : (
              <>
                <p
                  className={`akros-product-detail__stock akros-product-detail__stock--${stockState}`}
                >
                  {simpleStockLabel}
                </p>

                <div className="akros-product-detail__buying">
                  {purchasePriceTiers.length > 1 && !priceUnavailableReason && (
                    <dl className="akros-price-tiers" aria-label={cs.product.quantityPricing}>
                      {purchasePriceTiers.map((tier) => (
                        <div key={tier.minimumQuantity}>
                          <dt>
                            {cs.product.from} {number(tier.minimumQuantity)} {purchaseItem.unit}
                          </dt>
                          <dd>{formatPrice(tier.priceMinor, money)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {priceUnavailableReason ? (
                    <div className="akros-product-detail__price-unavailable" role="note">
                      <p className="akros-product-detail__price-row akros-product-detail__price-row--total">
                        <span>{cs.product.price}</span>
                        <strong>{cs.product.priceUnavailable}</strong>
                      </p>
                      <p className="akros-product-detail__price-reason">
                        {priceUnavailableReason} {cs.product.cannotBuyNow}
                      </p>
                    </div>
                  ) : (
                    <>
                      {basePriceTier && (
                        <p className="akros-product-detail__price-row">
                          <span>{cs.product.priceExcludingVat}</span>
                          <strong>
                            {formatPrice(basePriceTier.priceExcludingVatMinor, money)}
                          </strong>
                        </p>
                      )}
                      <p className="akros-product-detail__price-row akros-product-detail__price-row--total">
                        <span>{cs.product.priceIncludingVat}</span>
                        <strong>{formatPrice(purchaseItem.priceMinor, money)}</strong>
                      </p>
                    </>
                  )}
                  {purchaseItem.availabilityUnknown && !priceUnavailableReason && (
                    <p className="akros-product-detail__price-reason" role="note">
                      {cs.product.availabilityCannotConfirm}
                    </p>
                  )}

                  <div className="akros-product-detail__purchase-row">
                    <ProductPurchaseForm
                      product={purchaseProduct}
                      variant={singleVariant ? purchaseVariantOf(singleVariant) : undefined}
                    />
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
          <section id="product-variants" aria-label={cs.product.variantsTitle}>
            <ProductPurchaseForm
              initialVariantSearch={initialVariantSearch}
              product={purchaseProduct}
              variants={detail.variants.map(purchaseVariantOf)}
            />
          </section>
        )}

        {recommendations.length > 0 && (
          <section
            className="akros-product-detail__surface akros-section akros-section--product-recommendations"
            aria-labelledby="product-recommendations-title"
          >
            <h2 id="product-recommendations-title">{cs.catalog.recommendations}</h2>
            <ProductGrid
              action="detail"
              columns="related"
              products={recommendations.map(toProductSummary)}
            />
          </section>
        )}
      </article>
    </StorefrontShell>
  );
  // The browser navigation gets only this category branch, not the whole tree.
  return <CategoryBranch activeSlug={category?.slug}>{page}</CategoryBranch>;
}
