"use client";

import Image from "next/image";
import NextLink from "next/link";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { PrimaryLinkButton } from "@/components/primary-link-button";
import { AddToCartButton } from "@/features/cart/add-to-cart-button";
import { formatPrice } from "@/lib/format";

export interface NewsProductCardItem {
  id: string;
  productId: string;
  variantId?: string;
  slug: string;
  name: string;
  productName: string;
  sku: string;
  imageSrc: string;
  imageAlt: string;
  priceMinor: number;
  originalPriceMinor?: number;
  currency: "CZK";
  unit: string;
  stockCount: number;
  minimumQuantity: number;
  variantLabel?: string;
  kind: "new" | "action" | "sale";
}

const flagLabel = {
  new: "Novinka",
} as const;

const getDiscountPercentage = (priceMinor: number, originalPriceMinor?: number) =>
  originalPriceMinor && originalPriceMinor > priceMinor
    ? Math.round((1 - priceMinor / originalPriceMinor) * 100)
    : undefined;

export function NewsProductGrid({ items }: { items: NewsProductCardItem[] }) {
  return (
    <div className="akros-news-grid">
      {items.map((item) => {
        const discountPercentage = getDiscountPercentage(item.priceMinor, item.originalPriceMinor);

        return (
          <article className="akros-news-card-wrapper" key={item.id}>
            <ProductCard className="akros-news-product-card" layout="column">
              <NextLink href={`/produkt/${item.slug}`} aria-label={item.name}>
                <ProductCard.Image
                  as={Image}
                  alt={item.imageAlt}
                  height={480}
                  loading="lazy"
                  sizes="(max-width: 760px) 100vw, (max-width: 1100px) 50vw, 320px"
                  src={item.imageSrc}
                  width={480}
                />
              </NextLink>
              <ProductCard.Name className="akros-news-product-card__name">
                <NextLink className="akros-product-card__name-link" href={`/produkt/${item.slug}`}>
                  {item.name}
                </NextLink>
              </ProductCard.Name>
              {item.kind === "new" ? (
                <span className="akros-news-product-card__flag">{flagLabel[item.kind]}</span>
              ) : (
                <span className="akros-news-product-card__discount">
                  {discountPercentage ? `-${discountPercentage}%` : "Akce"}
                </span>
              )}
              <ProductCard.Price className="akros-news-product-card__price">
                <span className="akros-news-product-card__price-current">
                  {item.kind === "new" ? "od " : ""}
                  {formatPrice(item.priceMinor, item.currency)}
                </span>
                {item.kind !== "new" && item.originalPriceMinor ? (
                  <span className="akros-news-product-card__price-original">
                    {formatPrice(item.originalPriceMinor, item.currency)}
                  </span>
                ) : null}
              </ProductCard.Price>
              <ProductCard.Actions>
                {item.kind === "new" ? (
                  <PrimaryLinkButton href={`/produkt/${item.slug}`} size="sm" uppercase={false}>
                    Detail
                  </PrimaryLinkButton>
                ) : (
                  <AddToCartButton
                    item={{
                      productId: item.productId,
                      variantId: item.variantId,
                      slug: item.slug,
                      name: item.productName,
                      sku: item.sku,
                      imageSrc: item.imageSrc,
                      imageAlt: item.imageAlt,
                      unit: item.unit,
                      minimumQuantity: item.minimumQuantity,
                      stockCount: item.stockCount,
                      priceMinor: item.priceMinor,
                      variantLabel: item.variantLabel,
                    }}
                    label="Do košíku"
                    quantity={item.minimumQuantity}
                  />
                )}
              </ProductCard.Actions>
            </ProductCard>
          </article>
        );
      })}
    </div>
  );
}
