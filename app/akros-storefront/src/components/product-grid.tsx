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

export function ProductGrid({
  products,
  action = "purchase",
}: {
  products: CatalogProductSummary[];
  action?: "purchase" | "detail";
}) {
  return (
    <div className="akros-product-grid">
      {products.map((product, index) => (
        <ProductCard key={product.id} className="akros-product-card" layout="column">
          <NextLink href={`/produkt/${product.slug}`} aria-label={product.name}>
            <ProductCard.Image
              as={Image}
              alt={product.imageAlt}
              height={480}
              loading={index < 4 ? "eager" : "lazy"}
              sizes="(max-width: 430px) 100vw, (max-width: 1100px) 50vw, 240px"
              src={product.imageSrc}
              width={480}
            />
          </NextLink>
          <ProductCard.Name>
            <NextLink className="akros-product-card__name-link" href={`/produkt/${product.slug}`}>
              {product.name}
            </NextLink>
          </ProductCard.Name>
          {action === "purchase" && (
            <ProductCard.Price>
              {product.priceMinor > 0
                ? formatPrice(product.priceMinor, product.currency)
                : "Cena na dotaz"}
            </ProductCard.Price>
          )}
          <ProductCard.Stock status={getProductStockStatus(product)}>
            {cs.product.inStock}: {product.stockCount.toLocaleString("cs-CZ")} {product.unit}
          </ProductCard.Stock>
          <ProductCard.Actions>
            {action === "detail" ||
            product.hasVariants ||
            product.stockCount < product.minimumQuantity ||
            product.priceMinor <= 0 ? (
              <LinkButton
                as={NextLink}
                href={`/produkt/${product.slug}`}
                size="sm"
                variant="primary"
              >
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
                  stockCount: product.stockCount,
                  priceMinor: product.priceMinor,
                }}
              />
            )}
          </ProductCard.Actions>
        </ProductCard>
      ))}
    </div>
  );
}
