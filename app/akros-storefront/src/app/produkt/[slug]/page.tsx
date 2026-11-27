import type { Metadata } from "next";
import Image from "next/image";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { getBrand } from "@/brand";
import { ContentLink } from "@/components/content-link";
import { ProductDetailActions } from "@/components/product-detail-actions";
import { ProductDocuments } from "@/components/product-documents";
import { ProductGrid } from "@/components/product-grid";
import { ProductVariantDetail } from "@/components/product-variant-detail";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { CategoryBranch } from "@/ontos/category-branch";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { ProductVariantsProvider } from "@/features/cart/product-variants-context";
import { FavoriteButton } from "@/features/favorites/favorite-button";
import { formatPrice, formatWeight, priceUnavailableText } from "@/lib/format";
import { getProductDescriptionParagraphs } from "@/lib/product-description";
import { getProductStockStatus, stockStatusLabel } from "@/lib/product-stock";
import { getVariantRangeFilters } from "@/lib/product-variant-filters";
import { parseVariantIds, resolveVariantSelection } from "@/lib/product-variant-links";
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import {
  compareVariants,
  toFilterBounds,
  VARIANT_PAGE_SIZE,
  type VariantTablePage,
} from "@/lib/product-variant-table";
import { getDictionary, getMoney, marketHref } from "@/ontos/active-market";
import { getCatalog, getCatalogPage } from "@/ontos/catalog-server";
import { purchaseProductOf, purchaseVariantOf } from "@/ontos/catalog-projection";
import { isImagePlaceholder } from "@/ontos/media-path";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
  /** `variant`: a search term that narrows the variant table; `variantIds`: a shared/exact variant selection. */
  searchParams: Promise<{
    variant?: string | string[];
    variantIds?: string | string[];
    /** The variant detail dialog (opened by the variant table's links). */
    variantDetail?: string | string[];
  }>;
}

/** The one `full` read: this product with its variants, parameters and description (metadata and page share it). */
const getProductDetail = cache(
  async (slug: string) => (await getCatalogPage({ slug, pageSize: 1 }, { fields: "full" })).model,
);

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  const [product, cs] = await Promise.all([
    getProductDetail(slug).then((catalog) => catalog.getProductBySlug(slug)),
    getDictionary(),
  ]);

  if (!product) return { title: cs.product.title };
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const origin = host
    ? `${requestHeaders.get("x-forwarded-proto") ?? "https"}://${host}`
    : undefined;
  const absolute = (path: string) => (origin ? new URL(path, origin).toString() : path);
  const title = product.seoTitle || product.name;
  const description =
    product.seoDescription || product.detail.descriptionParagraphs[0] || product.description;
  const canonical = absolute(await marketHref(`/produkt/${slug}`));
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      images: [absolute(product.imageSrc)],
    },
  };
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
  const {
    variant: requestedVariantSearch,
    variantIds: requestedVariantIds,
    variantDetail: requestedVariantDetail,
  } = await searchParams;
  const product = getProductBySlug(slug);
  if (!product) notFound();

  const category = getCategoryById(product.categoryId);
  const categoryTrail = category ? getCategoryTrail(category) : [];
  const detail = product.detail;
  const purchaseProduct = purchaseProductOf(product);
  // One array for the table and the variant modal, so the RSC payload carries the variants once.
  const purchaseVariants = detail.variants.map(purchaseVariantOf);
  const sharedIds = parseVariantIds(requestedVariantIds);
  const sharedVariantIds = new Set(
    resolveVariantSelection(detail.variants, requestedVariantIds).map((variant) => variant.id),
  );
  const sharedVariants = purchaseVariants.filter((variant) => sharedVariantIds.has(variant.id));
  const singleVariant = detail.variants.length === 1 ? detail.variants[0] : undefined;
  const hasMultipleVariants = detail.variants.length > 1;
  const invalidSingleSelection =
    sharedIds.length > 0 && !hasMultipleVariants && !sharedVariants.length;
  const purchaseItem = singleVariant ?? product;
  const productWeight = formatWeight(
    singleVariant ? singleVariant.sourceNetWeight : product.netWeight,
    money.locale,
  );
  const purchasePriceTiers = singleVariant?.priceTiers.length
    ? singleVariant.priceTiers
    : detail.priceTiers;
  const basePriceTier =
    purchasePriceTiers.find((tier) => tier.minimumQuantity === purchaseItem.minimumQuantity) ??
    purchasePriceTiers[0];
  const packageQuantity = purchaseItem.packageQuantity;
  // A single-variant product shows the variant's struck price, else the product's own (Historie cen › Původní cena).
  const originalPriceMinor = purchaseItem.originalPriceMinor ?? product.originalPriceMinor;
  const variantStock = detail.variants.map(getProductStockStatus);
  const availableVariantCount = variantStock.filter((status) => status === "in-stock").length;
  const unknownVariantCount = variantStock.filter((status) => status === "unknown").length;
  const belowPackageVariantCount = variantStock.filter(
    (status) => status === "below-package",
  ).length;
  const number = (value: number, maximumFractionDigits = 0) =>
    value.toLocaleString(money.locale, { maximumFractionDigits });
  const priceUnavailableReason = purchaseItem.priceUnavailableReason
    ? priceUnavailableText(purchaseItem.priceUnavailableReason, cs, money)
    : purchaseItem.priceMinor > 0
      ? undefined
      : cs.product.noValidPrice;
  const variantSearch = Array.isArray(requestedVariantSearch)
    ? requestedVariantSearch[0]
    : requestedVariantSearch;
  const normalizedVariantSearch = normalizeCatalogSearchTerm(variantSearch ?? "");
  const initialVariantSearch =
    !sharedIds.length &&
    normalizedVariantSearch &&
    detail.variants.some((variant) => matchesProductVariantSearch(variant, normalizedVariantSearch))
      ? variantSearch?.trim()
      : undefined;
  // A long table ships only its first page (searched and sorted as the browser would); the browser reads
  // every variant once the shopper filters or pages. A shared selection is short and ships whole.
  const pagedTable = !sharedIds.length && purchaseVariants.length > VARIANT_PAGE_SIZE;
  const tableSearch = normalizeCatalogSearchTerm(initialVariantSearch ?? "");
  const matchingVariants = tableSearch
    ? purchaseVariants.filter((variant) => matchesProductVariantSearch(variant, tableSearch))
    : purchaseVariants;
  const tableVariants = sharedIds.length
    ? sharedVariants
    : pagedTable
      ? [...matchingVariants].sort(compareVariants).slice(0, VARIANT_PAGE_SIZE)
      : purchaseVariants;
  const variantPage: VariantTablePage | undefined = pagedTable
    ? {
        total: purchaseVariants.length,
        matching: matchingVariants.length,
        filters: getVariantRangeFilters(purchaseProduct, purchaseVariants).map(toFilterBounds),
      }
    : undefined;
  const detailVariantId = Array.isArray(requestedVariantDetail)
    ? requestedVariantDetail[0]
    : requestedVariantDetail;
  const detailVariant =
    detailVariantId && !tableVariants.some((variant) => variant.id === detailVariantId)
      ? purchaseVariants.find((variant) => variant.id === detailVariantId)
      : undefined;
  const productDescriptionParagraphs = getProductDescriptionParagraphs(
    detail.descriptionParagraphs,
  );
  // The printed sheet names the market's own product address.
  const productPath = await marketHref(`/produkt/${product.slug}`);
  const brand = getBrand();
  const materialMarkers = product.name.match(/\bA[1-5]\b|\b1\.\d{4}\b/gi) ?? [];
  const recommendationScore = (candidateName: string) =>
    materialMarkers.filter((marker) =>
      candidateName.toLocaleUpperCase("cs-CZ").includes(marker.toLocaleUpperCase("cs-CZ")),
    ).length;
  const relatedIds = (product.relatedProductIds ?? []).filter((id) => id !== product.id);
  const relatedProducts = relatedIds.length
    ? await getCatalogPage(
        { productIds: relatedIds, pageSize: relatedIds.length },
        { fields: "card" },
      )
        .then(({ products }) =>
          relatedIds.flatMap((id) => products.find((candidate) => candidate.id === id) ?? []),
        )
        .catch(() => [])
    : [];
  const recommendations = relatedProducts.length
    ? relatedProducts
    : featuredCatalog
        .getHomepageFeaturedProducts()
        .filter(
          (candidate) =>
            candidate.id !== product.id &&
            candidate.name.trim().toLocaleUpperCase("cs-CZ") !== "AKCE" &&
            candidate.priceMinor > 0 &&
            !isImagePlaceholder(candidate.imageSrc),
        )
        .sort(
          (left, right) =>
            recommendationScore(right.name) - recommendationScore(left.name) ||
            left.name.localeCompare(right.name, "cs"),
        )
        .slice(0, 3);

  const purchaseStock = getProductStockStatus(purchaseItem);
  const simpleStockLabel = stockStatusLabel(
    cs,
    purchaseStock,
    purchaseItem.belowPackage,
    purchaseItem.unit,
  );
  const stockState =
    purchaseStock === "unknown"
      ? "limited"
      : purchaseStock === "in-stock"
        ? "available"
        : "unavailable";

  const page = (
    <StorefrontShell activeCategorySlug={category?.slug}>
      <StorefrontBreadcrumbs
        className="sf-product-detail-breadcrumb"
        items={[
          { href: "/", label: cs.header.home },
          ...categoryTrail.map((item) => ({
            href: `/kategorie/${item.slug}`,
            label: item.name,
          })),
          { label: product.name },
        ]}
      />

      <article className="sf-product-detail">
        {invalidSingleSelection && (
          <div data-shared-variant-selection>
            <p>{cs.productPage.sharedSelectionGone}</p>
            <ContentLink href={`/produkt/${product.slug}`}>
              {cs.productPage.showCurrentProduct}
            </ContentLink>
          </div>
        )}
        <section className="sf-product-detail__overview" aria-labelledby="product-title">
          <div className="sf-product-detail__gallery">
            <Image
              alt={product.imageAlt}
              className="sf-product-detail__image sf-product-detail__image--primary"
              height={824}
              priority
              sizes="(max-width: 760px) 100vw, 50vw"
              src={product.imageSrc}
              width={1000}
            />
            {product.additionalImageSrcs?.length ? (
              <div className="sf-product-detail__thumbnails">
                {product.additionalImageSrcs.map((src, index) => (
                  <Image
                    alt={`${product.name} – ${cs.product.imageNumber(index + 2)}`}
                    className="sf-product-detail__image sf-product-detail__image--thumbnail"
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
                <div className="sf-product-detail__thumbnails">
                  <Image
                    alt={cs.product.technicalDrawing(product.name)}
                    className="sf-product-detail__image sf-product-detail__image--thumbnail"
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

          <div className="sf-product-detail__summary">
            <header className="sf-product-detail__heading">
              <h1 id="product-title">{product.name}</h1>
              {product.isRecommended && (
                <Badge size="md" variant="primary">
                  {cs.product.tags.recommended}
                </Badge>
              )}
              {product.isSale && (
                <Badge size="md" variant="discount">
                  {cs.product.tags.sale}
                </Badge>
              )}
              {product.isAction && (
                <Badge size="md" variant="discount">
                  {cs.product.tags.action}
                </Badge>
              )}
              {product.isNew && (
                <Badge size="md" variant="secondary">
                  {cs.product.tags.new}
                </Badge>
              )}
              {hasMultipleVariants && (
                <Badge className="sf-product-detail__variant-badge" size="md" variant="secondary">
                  {cs.product.moreVariants}
                </Badge>
              )}
              {singleVariant && (
                <Badge className="sf-product-detail__variant-badge" size="md" variant="secondary">
                  {cs.product.oneVariant}
                </Badge>
              )}
            </header>

            <dl className="sf-product-detail__facts">
              {packageQuantity !== undefined && packageQuantity > 1 && (
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
              {product.brand && (
                <div>
                  <dt>{cs.productPage.manufacturer}</dt>
                  <dd>{product.brand}</dd>
                </div>
              )}
              {!hasMultipleVariants && productWeight && (
                <div>
                  <dt>{cs.productPage.weight}</dt>
                  <dd>{productWeight}</dd>
                </div>
              )}
              {product.dimensionsText && (
                <div>
                  <dt>{cs.productPage.dimensions}</dt>
                  <dd>{product.dimensionsText}</dd>
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
                className={`sf-product-detail__stock${availableVariantCount > 0 ? "" : " sf-product-detail__stock--unavailable"}`}
              >
                {availableVariantCount > 0
                  ? cs.product.variantsInStock(availableVariantCount, detail.variants.length)
                  : unknownVariantCount > 0
                    ? cs.product.variantsUnknown
                    : belowPackageVariantCount > 0
                      ? cs.product.stockStatus["below-package"]
                      : cs.product.variantsOutOfStock}
              </p>
            ) : (
              <>
                <p className={`sf-product-detail__stock sf-product-detail__stock--${stockState}`}>
                  {simpleStockLabel}
                </p>

                {!invalidSingleSelection && (
                  <div className="sf-product-detail__buying">
                    {purchasePriceTiers.length > 1 && !priceUnavailableReason && (
                      <dl className="sf-price-tiers" aria-label={cs.product.quantityPricing}>
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
                      <div className="sf-product-detail__price-unavailable" role="note">
                        <p className="sf-product-detail__price-row sf-product-detail__price-row--total">
                          <span>{cs.product.price}</span>
                          <strong>{cs.product.priceUnavailable}</strong>
                        </p>
                        <p className="sf-product-detail__price-reason">
                          {priceUnavailableReason} {cs.product.cannotBuyNow}
                        </p>
                      </div>
                    ) : (
                      <>
                        {basePriceTier && (
                          <p className="sf-product-detail__price-row">
                            <span>{cs.product.priceExcludingVat}</span>
                            <strong>
                              {formatPrice(basePriceTier.priceExcludingVatMinor, money)}
                            </strong>
                          </p>
                        )}
                        {originalPriceMinor !== undefined &&
                          originalPriceMinor > purchaseItem.priceMinor && (
                            <p className="sf-product-detail__price-row">
                              <span>{cs.product.originalPrice}</span>
                              <s>{formatPrice(originalPriceMinor, money)}</s>
                            </p>
                          )}
                        <p className="sf-product-detail__price-row sf-product-detail__price-row--total">
                          <span>{cs.product.priceIncludingVat}</span>
                          <strong>{formatPrice(purchaseItem.priceMinor, money)}</strong>
                        </p>
                      </>
                    )}
                    {purchaseItem.availabilityUnknown && !priceUnavailableReason && (
                      <p className="sf-product-detail__price-reason" role="note">
                        {cs.product.availabilityCannotConfirm}
                      </p>
                    )}

                    <div className="sf-product-detail__purchase-row lg:items-start">
                      <ProductPurchaseForm
                        product={purchaseProduct}
                        variant={singleVariant ? purchaseVariants[0] : undefined}
                      />
                      <FavoriteButton
                        productId={product.id}
                        productName={product.name}
                        productSlug={product.slug}
                        variantId={singleVariant?.id ?? null}
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            <ProductDetailActions
              productId={product.id}
              productName={product.name}
              productSlug={product.slug}
              showVariantFavorites={hasMultipleVariants}
            />
            <section
              className="sf-product-detail__delivery"
              aria-labelledby="product-delivery-title"
            >
              <h2 id="product-delivery-title">{cs.productPage.deliveryTitle}</h2>
              <p>{cs.productPage.deliveryText}</p>
              <ContentLink
                href="/doprava-a-platba"
                theme="borderless"
                variant="secondary"
                size="current"
                className="justify-self-start"
              >
                {cs.productPage.deliveryLink}
              </ContentLink>
            </section>
          </div>
        </section>

        <section className="sf-product-detail__surface" aria-labelledby="description-title">
          <h2 id="description-title">{cs.product.details}</h2>
          {productDescriptionParagraphs.length > 0 ? (
            productDescriptionParagraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)
          ) : (
            <p>{cs.productPage.descriptionUnavailable}</p>
          )}
          {detail.parameters.length > 0 && (
            <ul className="sf-product-parameters">
              {detail.parameters.map((parameter) => (
                <li key={parameter.label}>
                  {parameter.label}: {parameter.value}
                  {parameter.unit && ` ${parameter.unit}`}
                </li>
              ))}
            </ul>
          )}
          <ProductDocuments documents={product.documents ?? []} title={cs.productPage.documents} />
        </section>

        {hasMultipleVariants && (
          <section id="product-variants" aria-label={cs.product.variantsTitle} tabIndex={-1}>
            {sharedIds.length > 0 && (
              <div className="sf-shared-selection" data-shared-variant-selection>
                <p>
                  {sharedVariants.length
                    ? cs.productPage.sharedSelection(sharedVariants.length)
                    : cs.productPage.sharedSelectionGone}
                  {sharedVariants.length > 0 &&
                    sharedVariants.length < sharedIds.length &&
                    ` ${cs.productPage.sharedSelectionPartial}`}
                </p>
                <ContentLink href={`/produkt/${product.slug}#product-variants`}>
                  {cs.productPage.showAllVariants}
                </ContentLink>
              </div>
            )}
            {(!sharedIds.length || sharedVariants.length > 0) && (
              <ProductPurchaseForm
                key={sharedIds.join(",") || "all"}
                initialVariantSearch={initialVariantSearch}
                product={purchaseProduct}
                variants={tableVariants}
                variantPage={variantPage}
              />
            )}
          </section>
        )}

        {recommendations.length > 0 && (
          <section
            className="sf-product-detail__surface sf-section sf-section--product-recommendations"
            aria-labelledby="product-recommendations-title"
          >
            <h2 id="product-recommendations-title">
              {relatedProducts.length ? cs.productPage.related : cs.catalog.recommendations}
            </h2>
            <ProductGrid
              action="detail"
              columns="related"
              products={recommendations.map(toProductSummary)}
            />
          </section>
        )}
      </article>

      {hasMultipleVariants && (
        <ProductVariantDetail
          product={purchaseProduct}
          variants={tableVariants}
          detailVariant={detailVariant}
          descriptionParagraphs={productDescriptionParagraphs}
        />
      )}

      {/* Printed by the print action only (display: none on screen); hidden from assistive technology. */}
      <section className="sf-print-sheet" aria-hidden="true">
        <p>{cs.productPage.printHeading(brand.name)}</p>
        <h1>{product.name}</h1>
        <Image
          src={product.imageSrc}
          alt={product.imageAlt}
          width={1000}
          height={824}
          sizes="(max-width: 760px) 100vw, 50vw"
          loading="eager"
        />
        <p>{cs.productPage.printSku(purchaseItem.sku)}</p>
        {product.brand && (
          <p>
            {cs.productPage.manufacturer}: {product.brand}
          </p>
        )}
        {!hasMultipleVariants && (
          <p>
            {cs.productPage.printPrice(
              priceUnavailableReason
                ? cs.product.priceUnavailable
                : `${formatPrice(purchaseItem.priceMinor, money)} / ${purchaseItem.unit}`,
            )}
          </p>
        )}
        {hasMultipleVariants && <p>{cs.productPage.printVariants(detail.variants.length)}</p>}
        {productDescriptionParagraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <dl>
          {detail.parameters.map((parameter) => (
            <div key={parameter.label}>
              <dt>{parameter.label}</dt>
              <dd>
                {parameter.value} {parameter.unit}
              </dd>
            </div>
          ))}
        </dl>
        <p>{cs.productPage.printLink(productPath)}</p>
      </section>
    </StorefrontShell>
  );
  // The browser navigation gets only this category branch, not the whole tree. The variant table and the
  // variant detail dialog share one on-demand read of every variant.
  return (
    <CategoryBranch activeSlug={category?.slug}>
      <ProductVariantsProvider slug={product.slug}>{page}</ProductVariantsProvider>
    </CategoryBranch>
  );
}
