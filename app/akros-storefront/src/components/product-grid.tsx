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
  columns?: "catalog" | "checkout" | "featured";
}) {
  const gridClassName =
    columns === "featured"
      ? "grid grid-cols-1 gap-x-5 gap-y-12 px-4 min-[431px]:grid-cols-2 min-[1101px]:grid-cols-4 max-md:gap-x-3 max-md:gap-y-6 max-md:px-2"
      : columns === "checkout"
        ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        : "akros-product-grid";

  return (
    <div className={gridClassName}>
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

        return (
          <article className="min-w-0" key={product.id}>
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
                    sizes="(max-width: 430px) 100vw, (max-width: 1100px) 50vw, 234px"
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

              <div className="flex items-center justify-between gap-2 py-1">
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

              <p className="m-0 line-clamp-2 min-h-[2.8em] text-sm leading-normal text-(--color-fg-secondary)">
                {supportingText}
              </p>
              {product.searchMatchLabel && (
                <p className="akros-product-card__search-match">{product.searchMatchLabel}</p>
              )}

              <ProductCard.Price className="mt-auto mb-0 text-center">
                {priceLabel}
              </ProductCard.Price>

              <ProductCard.Actions className="mt-auto block [&>*]:w-full">
                {canAddToCart && product.stock.kind === "quantity" ? (
                  <AddToCartButton
                    item={{
                      productId: product.id,
                      slug: product.slug,
                      name: product.name,
                      sku: product.sku,
                      imageSrc: product.imageSrc,
                      imageAlt: product.imageAlt,
                      unit: product.stock.unit,
                      minimumQuantity: product.stock.minimumQuantity,
                      stockCount: product.stock.stockCount,
                      priceMinor: product.priceMinor,
                      priceExcludingVatMinor: product.priceExcludingVatMinor,
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
