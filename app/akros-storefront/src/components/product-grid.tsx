"use client";

import Image from "next/image";
import NextLink from "next/link";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { AddToCartButton } from "@/features/cart/add-to-cart-button";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import type { CatalogProductSummary } from "@/mock-storefront/types";

export interface ProductGridItem extends CatalogProductSummary {
  detailHref?: string;
  searchMatchLabel?: string;
  variantId?: string;
  variantLabel?: string;
  productName?: string;
}

const stockLabels = {
  "in-stock": "Skladem",
  "limited-stock": "Omezeně skladem",
  "out-of-stock": "Není skladem",
} as const;

export function ProductGrid({
  products,
  action = "purchase",
  columns = "catalog",
}: {
  products: ProductGridItem[];
  action?: "purchase" | "detail";
  columns?: "catalog" | "checkout" | "featured" | "related";
}) {
  const isListing = columns === "catalog" || columns === "featured";
  const imageSizes = isListing
    ? "(max-width: 359px) 100vw, (max-width: 1100px) 50vw, 234px"
    : "(max-width: 430px) 100vw, (max-width: 1100px) 50vw, 234px";
  const gridClassName =
    columns === "featured"
      ? "grid grid-cols-1 gap-x-5 gap-y-12 px-4 min-[431px]:grid-cols-2 min-[1101px]:grid-cols-4 max-md:gap-x-3 max-md:gap-y-6 max-md:px-2"
      : columns === "checkout"
        ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        : "akros-product-grid";

  return (
    <div className={gridClassName} data-akros-product-listing={isListing ? columns : undefined}>
      {products.map((product, index) => {
        const detailHref = product.detailHref ?? `/produkt/${product.slug}`;
        const canAddToCart =
          action === "purchase" &&
          !product.hasVariants &&
          product.priceMinor > 0 &&
          product.stock.kind === "quantity" &&
          product.stock.status === "in-stock";
        const priceLabel =
          product.priceMinor > 0
            ? `${product.priceIsFrom ? `${cs.product.from} ` : ""}${formatPrice(product.priceMinor, product.currency)}`
            : "Cena na dotaz";
        const supportingText = product.description.trim() || `Kód produktu: ${product.sku}`;
        const comparisonPrice = product.originalPriceMinor;
        const hasDiscount =
          !product.priceIsFrom &&
          Number.isSafeInteger(product.priceMinor) &&
          product.priceMinor > 0 &&
          comparisonPrice !== undefined &&
          Number.isSafeInteger(comparisonPrice) &&
          comparisonPrice > product.priceMinor;
        const discountPercentage = hasDiscount
          ? Math.round((1 - product.priceMinor / comparisonPrice) * 100)
          : undefined;

        return (
          <article className="min-w-0" key={product.variantId ?? product.id}>
            <ProductCard className="akros-product-card akros-catalog-product-card" layout="column">
              <div className="relative">
                <NextLink
                  aria-label={product.name}
                  className="akros-catalog-product-card__image-link flex items-center justify-center"
                  href={detailHref}
                >
                  <ProductCard.Image
                    as={Image}
                    alt={product.imageAlt}
                    className="akros-catalog-product-card__image object-contain"
                    height={480}
                    loading={index < 4 ? "eager" : "lazy"}
                    sizes={imageSizes}
                    src={product.imageSrc}
                    width={480}
                  />
                  {(product.isRecommended || product.isSale || product.isAction) && (
                    <div
                      className="absolute top-0 left-0 grid justify-items-start gap-1 pr-11"
                      data-akros-product-tags
                    >
                      {product.isRecommended && (
                        <Badge size="sm" variant="primary">
                          {cs.product.tags.recommended}
                        </Badge>
                      )}
                      {product.isSale ? (
                        <Badge
                          size="sm"
                          title={product.hasVariants ? cs.product.tags.saleVariants : undefined}
                          variant="discount"
                        >
                          {cs.product.tags.sale}
                        </Badge>
                      ) : product.isAction ? (
                        <Badge
                          size="sm"
                          title={product.hasVariants ? cs.product.tags.actionVariants : undefined}
                          variant="discount"
                        >
                          {cs.product.tags.action}
                        </Badge>
                      ) : null}
                    </div>
                  )}
                </NextLink>
                <LinkButton
                  aria-label="Zobrazit oblíbené produkty"
                  as={NextLink}
                  className="absolute top-0 right-0 size-11 rounded-full p-0 text-(--color-neutral-400)"
                  href="/oblibene"
                  icon="icon-[mdi--heart-outline]"
                  iconSize="lg"
                  size="current"
                  theme="borderless"
                  variant="secondary"
                />
              </div>

              <ProductCard.Name className="akros-catalog-product-card__name m-0 text-center uppercase">
                <NextLink className="akros-product-card__name-link" href={detailHref}>
                  {product.name}
                </NextLink>
              </ProductCard.Name>

              <div className="akros-product-card__stock-row flex items-center justify-between gap-2 py-1">
                <ProductCard.Stock
                  className="akros-catalog-product-card__stock m-0 uppercase"
                  status={product.stock.status}
                >
                  {stockLabels[product.stock.status]}
                </ProductCard.Stock>
                {product.hasVariants && (
                  <Badge
                    bgColor="var(--color-base-dark)"
                    borderColor="var(--color-base-dark)"
                    className="whitespace-nowrap"
                    fgColor="var(--color-base-light)"
                    size="sm"
                    variant="dynamic"
                  >
                    Více variant
                  </Badge>
                )}
              </div>

              <p className="akros-product-card__description m-0 line-clamp-2 min-h-[2.8em] text-sm leading-normal text-(--color-fg-secondary)">
                {supportingText}
              </p>
              {product.searchMatchLabel && (
                <p className="akros-product-card__search-match">{product.searchMatchLabel}</p>
              )}

              <ProductCard.Price className="mt-auto mb-0 text-center">
                {hasDiscount ? (
                  <>
                    <span className="akros-product-card__discount">
                      {discountPercentage === 0 ? "<1%" : `-${discountPercentage}%`}
                    </span>
                    <span className="flex flex-wrap items-baseline justify-center gap-1">
                      <span>{priceLabel}</span>
                      <del className="akros-product-card__original-price">
                        <span className="sr-only">{cs.product.originalPrice}: </span>
                        {formatPrice(comparisonPrice, product.currency)}
                      </del>
                    </span>
                  </>
                ) : (
                  priceLabel
                )}
              </ProductCard.Price>

              <ProductCard.Actions
                className="mt-auto block [&>*]:w-full"
                data-akros-product-actions
              >
                {canAddToCart && product.stock.kind === "quantity" ? (
                  <AddToCartButton
                    item={{
                      productId: product.id,
                      variantId: product.variantId,
                      slug: product.slug,
                      name: product.productName ?? product.name,
                      sku: product.sku,
                      imageSrc: product.imageSrc,
                      imageAlt: product.imageAlt,
                      unit: product.stock.unit,
                      minimumQuantity: product.stock.minimumQuantity,
                      stockCount: product.stock.stockCount,
                      priceMinor: product.priceMinor,
                      priceExcludingVatMinor: product.priceExcludingVatMinor,
                      variantLabel: product.variantLabel,
                    }}
                    quantity={product.stock.minimumQuantity}
                  />
                ) : (
                  <LinkButton
                    as={NextLink}
                    block
                    href={detailHref}
                    size="sm"
                    uppercase
                    variant="primary"
                  >
                    {product.hasVariants ? "Vybrat variantu" : cs.actions.viewDetail}
                  </LinkButton>
                )}
              </ProductCard.Actions>
            </ProductCard>
          </article>
        );
      })}
    </div>
  );
}
