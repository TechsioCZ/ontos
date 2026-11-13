"use client";

import NextImage from "next/image";
import NextLink from "next/link";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import { Link } from "@/features/plain-link";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import type { Dictionary } from "@/i18n";
import type { CatalogModel } from "@/ontos/catalog-model";
import { priceProps } from "./price-props";
import { CardPurchase } from "./card-purchase";

/** Mobile category cards keep the authored image, name, price, availability and action order. */
export const ListingCards = ({
  catalog,
  dictionary: d,
  locale,
}: {
  catalog: CatalogModel;
  dictionary: Dictionary;
  locale: string;
}) => (
  <div className="grid gap-6">
    {catalog.products.map((product, index) => {
      const href = `/${locale}/produkt/${encodeURIComponent(product.slug)}`;
      const available = product.stock === "available" || product.stock === "limited";
      const chooseVariant = available && (product.variantCount ?? 0) > 0;
      const directPurchase = available && product.variantCount === 0 && product.priceMinor !== null;
      return (
        <ProductCard key={product.id} layout="column" shadow={false}>
          <Link aria-hidden="true" as={NextLink} href={href} tabIndex={-1}>
            {product.image === null ? (
              <p className="py-12 text-center text-fg-secondary">{d.imageUnavailable}</p>
            ) : (
              <div className="relative mx-auto aspect-4/3 w-full max-w-84">
                <ProductCard.Image
                  alt={product.name}
                  as={NextImage}
                  fill
                  loading={index === 0 ? "eager" : "lazy"}
                  objectFit="contain"
                  sizes="(max-width: 767px) calc(100vw - 54px), 336px"
                  src={product.image}
                />
              </div>
            )}
          </Link>
          <div className="min-h-12">
            <ProductCard.Name>
              <Link as={NextLink} href={href}>
                {product.name}
              </Link>
            </ProductCard.Name>
          </div>
          <div>
            <PriceBlock
              {...priceProps(product, d, locale, product.priceExcludingVatMinor ?? null)}
            />
          </div>
          <div>
            <AvailabilityStatus label={d.stock[product.stock]} status={product.stock} />
          </div>
          <div>
            {directPurchase ? (
              <CardPurchase dictionary={d} presentation="listing" product={product} />
            ) : (
              <LinkButton
                as={NextLink}
                block
                href={href}
                size="md"
                theme="outlined"
                variant="secondary"
              >
                {chooseVariant ? d.selectVariantListing : d.detail}
              </LinkButton>
            )}
          </div>
        </ProductCard>
      );
    })}
  </div>
);
