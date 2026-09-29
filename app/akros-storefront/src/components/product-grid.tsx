"use client";

import Image from "next/image";
import NextLink from "next/link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import styles from "./product-grid.module.css";
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
}: {
  products: ProductGridItem[];
  action?: "purchase" | "detail";
}) {
  return (
    <div className={`akros-product-grid ${styles.grid}`}>
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
          <article className={styles.cardShell} key={product.id}>
            <ProductCard
              className={`akros-product-card akros-catalog-product-card ${styles.card}`}
              layout="column"
            >
              <div className={styles.media}>
                <NextLink
                  aria-label={product.name}
                  className={`akros-catalog-product-card__image-link ${styles.imageLink}`}
                  href={detailHref}
                >
                  <ProductCard.Image
                    as={Image}
                    alt={product.imageAlt}
                    className={`akros-catalog-product-card__image ${styles.image}`}
                    height={480}
                    loading={index < 4 ? "eager" : "lazy"}
                    sizes="(max-width: 430px) 100vw, (max-width: 1100px) 50vw, 234px"
                    src={product.imageSrc}
                    width={480}
                  />
                </NextLink>
                <LinkButton
                  aria-label="Zobrazit oblíbené produkty"
                  as={NextLink}
                  className={styles.favoriteLink}
                  href="/oblibene"
                  icon="icon-[mdi--heart-outline]"
                  iconSize="lg"
                  size="current"
                  theme="unstyled"
                  variant="secondary"
                />
              </div>

              <ProductCard.Name className={`akros-catalog-product-card__name ${styles.name}`}>
                <NextLink className="akros-product-card__name-link" href={detailHref}>
                  {product.name}
                </NextLink>
              </ProductCard.Name>

              <div className={styles.stockRow}>
                <ProductCard.Stock
                  className={`akros-catalog-product-card__stock ${styles.stock}`}
                  status={product.stock.status}
                >
                  {stockLabels[product.stock.status]}
                </ProductCard.Stock>
                {product.hasVariants && <span className={styles.variantPill}>Více variant</span>}
              </div>

              <p className={styles.description}>{supportingText}</p>
              {product.searchMatchLabel && (
                <p className={`akros-product-card__search-match ${styles.searchMatch}`}>
                  {product.searchMatchLabel}
                </p>
              )}

              <ProductCard.Price className={styles.price}>{priceLabel}</ProductCard.Price>

              <ProductCard.Actions className={styles.actions}>
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
                    }}
                    quantity={product.stock.minimumQuantity}
                  />
                ) : (
                  <LinkButton
                    as={NextLink}
                    block
                    href={detailHref}
                    size="lg"
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
