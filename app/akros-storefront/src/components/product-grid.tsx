"use client";

import Image from "next/image";
import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { AddToCartButton } from "@/features/cart/add-to-cart-button";
import { cs } from "@/i18n/cs";
import { formatPrice } from "@/lib/format";
import { getProductStockStatus } from "@/lib/product-stock";
import type { CatalogProductSummary } from "@/mock-storefront/types";

export interface ProductGridItem extends CatalogProductSummary {
  detailHref?: string;
  searchMatchLabel?: string;
}

export function ProductGrid({
  products,
  action = "purchase",
}: {
  products: ProductGridItem[];
  action?: "purchase" | "detail";
}) {
  return (
    <div className="akros-product-grid">
      {products.map((product, index) => {
        const detailHref = product.detailHref ?? `/produkt/${product.slug}`;

        return (
          <ProductCard
            key={product.id}
            className="akros-product-card akros-catalog-product-card"
            layout="column"
          >
            <NextLink
              className="akros-catalog-product-card__image-link"
              href={detailHref}
              aria-label={product.name}
            >
              <ProductCard.Image
                as={Image}
                className="akros-catalog-product-card__image"
                alt={product.imageAlt}
                height={480}
                loading={index < 4 ? "eager" : "lazy"}
                sizes="(max-width: 430px) 100vw, (max-width: 1100px) 50vw, 240px"
                src={product.imageSrc}
                width={480}
              />
            </NextLink>
            <ProductCard.Name className="akros-catalog-product-card__name">
              <NextLink className="akros-product-card__name-link" href={detailHref}>
                {product.name}
              </NextLink>
            </ProductCard.Name>
            {product.searchMatchLabel && (
              <p className="akros-product-card__search-match">{product.searchMatchLabel}</p>
            )}
            {action === "purchase" && (
              <ProductCard.Price>
                {product.priceMinor > 0
                  ? formatPrice(product.priceMinor, product.currency)
                  : "Cena na dotaz"}
              </ProductCard.Price>
            )}
            <ProductCard.Stock
              className="akros-catalog-product-card__stock"
              status={getProductStockStatus(product)}
            >
              {cs.product.inStock}: {product.stockCount.toLocaleString("cs-CZ")} {product.unit}
            </ProductCard.Stock>
            <ProductCard.Actions>
              {action === "detail" ||
              product.hasVariants ||
              product.stockCount < product.minimumQuantity ||
              product.priceMinor <= 0 ? (
                <LinkButton as={NextLink} href={detailHref} size="sm" variant="primary">
                  {cs.actions.viewDetail}
                </LinkButton>
              ) : (
                <AddToCartButton
                  item={{
                    productId: product.id,
                    slug: product.slug,
                    name: product.name,
                    sku: product.sku,
                    imageSrc: product.imageSrc,
                    imageAlt: product.imageAlt,
                    unit: product.unit,
                    minimumQuantity: product.minimumQuantity,
                    stockCount: product.stockCount,
                    priceMinor: product.priceMinor,
                  }}
                />
              )}
            </ProductCard.Actions>
          </ProductCard>
        );
      })}
    </div>
  );
}
