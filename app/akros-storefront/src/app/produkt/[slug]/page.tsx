import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Badge } from "@techsio/ui-kit/atoms/badge";

import { ProductDetailActions } from "@/components/product-detail-actions";
import { ProductVariantDetail } from "@/components/product-variant-detail";
import { parseVariantIds, resolveVariantSelection } from "@/lib/product-variant-links";
import StoreLink from "@/components/store-link";
import { ProductGrid } from "@/components/product-grid";
import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import { StorefrontShell } from "@/components/storefront-shell";
import { CategoryBranch } from "@/ontos/category-branch";
import { ProductPurchaseForm } from "@/features/cart/product-purchase-form";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import { getCatalog, getCatalogPage } from "@/ontos/catalog-server";
import { purchaseProductOf, purchaseVariantOf } from "@/ontos/catalog-projection";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ variant?: string | string[]; variantIds?: string | string[] }>;
}

const isQuantityPricingCopy = (paragraph: string) =>
  /množstevních slev|snížená cena|snížení ceny/i.test(paragraph);

/** The one `full` read: this product with its variants, parameters and description. */
const getProductDetail = async (slug: string) =>
  (await getCatalogPage({ slug, pageSize: 1 }, { fields: "full" })).model;

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = (await getProductDetail(slug)).getProductBySlug(slug);

  return { title: product?.name ?? "Produkt" };
}

export default async function ProductPage({ params, searchParams }: ProductPageProps) {
  const { slug } = await params;
  // Recommendations come from the homepage selection (cards), read alongside the product detail.
  const [
    featuredCatalog,
    { getCategoryById, getCategoryTrail, getProductBySlug, toProductSummary },
  ] = await Promise.all([getCatalog(), getProductDetail(slug)]);
  const { variant: requestedVariantSearch, variantIds } = await searchParams;
  const product = getProductBySlug(slug);
  if (!product) notFound();

  const category = getCategoryById(product.categoryId);
  const categoryTrail = category ? getCategoryTrail(category) : [];
  const detail = product.detail;
  const selectedIds = parseVariantIds(variantIds);
  const selectedVariants = selectedIds.length
    ? resolveVariantSelection(detail.variants, variantIds)
    : detail.variants;
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
  const priceUnavailableReason =
    purchaseItem.priceUnavailableReason ??
    (purchaseItem.priceMinor > 0 ? undefined : "OntOS pro tuto položku nevrátil platnou cenu.");
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
    ? "Dostupnost nyní nelze ověřit"
    : purchaseItem.stockCount >= purchaseItem.minimumQuantity
      ? `Skladem ${purchaseItem.stockCount.toLocaleString("cs-CZ")} ${purchaseItem.unit}`
      : purchaseItem.stockCount > 0
        ? `Omezené množství: ${purchaseItem.stockCount.toLocaleString("cs-CZ")} ${purchaseItem.unit}`
        : "Není skladem";
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
        <ProductVariantDetail
          product={purchaseProduct}
          descriptionParagraphs={productDescriptionParagraphs}
        />
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
                    alt={`${product.name} – obrázek ${index + 2}`}
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
                    alt={`Technický nákres: ${product.name}`}
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
              {!hasMultipleVariants && product.netWeight && (
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
                    {hasMultipleVariants && product.quantityStep
                      ? "Dle zvolené varianty – pouze celá balení"
                      : `${purchaseItem.minimumQuantity.toLocaleString("cs-CZ")} ${purchaseItem.unit}`}
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
                  : unknownVariantCount > 0
                    ? "Dostupnost variant nyní nelze ověřit"
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
                  {purchasePriceTiers.length > 1 && !priceUnavailableReason && (
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

                  {priceUnavailableReason ? (
                    <div className="akros-product-detail__price-unavailable" role="note">
                      <p className="akros-product-detail__price-row akros-product-detail__price-row--total">
                        <span>Cena</span>
                        <strong>Cena není dostupná</strong>
                      </p>
                      <p className="akros-product-detail__price-reason">
                        {priceUnavailableReason} Koupit ji proto nyní nelze.
                      </p>
                    </div>
                  ) : (
                    <>
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
                    </>
                  )}
                  {purchaseItem.availabilityUnknown && !priceUnavailableReason && (
                    <p className="akros-product-detail__price-reason" role="note">
                      OntOS nyní nemůže potvrdit skladovou dostupnost, proto položku nelze vložit do
                      košíku.
                    </p>
                  )}

                  <div className="akros-product-detail__purchase-row">
                    <ProductPurchaseForm
                      product={purchaseProduct}
                      variant={singleVariant ? purchaseVariantOf(singleVariant) : undefined}
                    />
                  </div>
                </div>
              </>
            )}

            <ProductDetailActions
              productId={product.id}
              productName={product.name}
              productSlug={product.slug}
              variantId={hasMultipleVariants ? undefined : (singleVariant?.id ?? null)}
            />
            <div className="akros-product-delivery-info">
              <h2>Doprava a platba</h2>
              <p>Způsob dopravy zvolíte v košíku.</p>
              <StoreLink href="/doprava-a-platba">Více o dopravě a platbě</StoreLink>
            </div>
          </div>
        </section>

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

        {hasMultipleVariants && (
          <section id="product-variants" aria-label="Varianty produktu">
            {selectedIds.length > 0 && selectedVariants.length === 0 ? (
              <p role="alert">
                Vybrané varianty už nejsou dostupné.{" "}
                <StoreLink href={`/produkt/${product.slug}#product-variants`}>
                  Zobrazit všechny varianty
                </StoreLink>
              </p>
            ) : (
              <ProductPurchaseForm
                initialVariantSearch={initialVariantSearch}
                product={purchaseProduct}
                variants={selectedVariants.map(purchaseVariantOf)}
              />
            )}
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
      <section className="akros-print-sheet" aria-label="Produktový list pro tisk">
        <p>AKROS — produktový list</p>
        <h1>{product.name}</h1>
        <Image
          src={product.imageSrc}
          alt={product.imageAlt}
          width={1000}
          height={824}
          sizes="60mm"
          loading="eager"
        />
        <p>Kód produktu: {purchaseItem.sku}</p>
        {!hasMultipleVariants && (
          <p>
            Cena s DPH:{" "}
            {purchaseItem.priceMinor > 0
              ? `${formatPrice(purchaseItem.priceMinor)} / ${purchaseItem.unit}`
              : "Cena není dostupná."}
          </p>
        )}
        {hasMultipleVariants && (
          <p>
            Počet variant: {detail.variants.length}. Ceny a dostupnost jednotlivých variant najdete
            v e-shopu.
          </p>
        )}
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
      </section>
    </StorefrontShell>
  );
  // The browser navigation gets only this category branch, not the whole tree.
  return <CategoryBranch activeSlug={category?.slug}>{page}</CategoryBranch>;
}
