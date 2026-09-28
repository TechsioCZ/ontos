"use client";

import Image from "next/image";
import NextLink from "next/link";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { PrimaryLinkButton } from "@/components/primary-link-button";
import { cs } from "@/i18n/cs";
import type { CatalogProductSummary } from "@/mock-storefront/types";

export function FeaturedProductGrid({ products }: { products: CatalogProductSummary[] }) {
  return (
    <div className="akros-product-grid akros-featured-product-grid">
      {products.map((product) => (
        <ProductCard
          key={product.id}
          className="akros-product-card akros-featured-product-card"
          layout="column"
        >
          <NextLink
            className="akros-featured-product-card__image-link"
            href={`/produkt/${product.slug}`}
            aria-label={product.name}
          >
            <ProductCard.Image
              as={Image}
              className="akros-featured-product-card__image"
              alt={product.imageAlt}
              height={480}
              loading="lazy"
              sizes="(max-width: 760px) 100vw, (max-width: 1100px) 50vw, 232px"
              src={product.imageSrc}
              width={424}
            />
          </NextLink>
          <ProductCard.Name className="leading-tight">
            <NextLink className="akros-product-card__name-link" href={`/produkt/${product.slug}`}>
              {product.name}
            </NextLink>
          </ProductCard.Name>
          <ProductCard.Stock className="leading-tight" status="in-stock">
            {cs.product.inStock}
          </ProductCard.Stock>
          <ProductCard.Actions>
            <PrimaryLinkButton href={`/produkt/${product.slug}`} size="sm" uppercase={false}>
              {cs.actions.viewDetail}
            </PrimaryLinkButton>
          </ProductCard.Actions>
        </ProductCard>
      ))}
    </div>
  );
}
