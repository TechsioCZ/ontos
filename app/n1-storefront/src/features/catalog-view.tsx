"use client";

import NextLink from "next/link";
import NextImage from "next/image";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import { Link } from "@techsio/ui-kit/atoms/link";
import { Button } from "@techsio/ui-kit/atoms/button";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import type { Dictionary } from "@/i18n";
import type { CatalogModel } from "@/ontos/catalog-model";
import { priceProps } from "./price-props";
import { CardVariants } from "./card-variants";

const stockStatus = {
  available: "in-stock",
  limited: "limited-stock",
  unavailable: "out-of-stock",
} as const;

interface CatalogViewProps {
  catalog: CatalogModel;
  dictionary: Dictionary;
  locale: string;
  presentation?: "featured" | "listing";
  title: string;
}

/** Kit composition over the owner's projected price and availability. */
export const CatalogView = ({
  catalog,
  dictionary: d,
  locale,
  presentation = "featured",
  title,
}: CatalogViewProps) => {
  if (!catalog.configured || catalog.products.length === 0) {
    return (
      <section
        className={presentation === "featured" ? "mx-auto max-w-n1-content px-4 py-12" : "py-6"}
      >
        {presentation === "featured" && <h1 className="mb-6 text-lg font-bold">{title}</h1>}
        <output>{catalog.configured ? d.empty : d.offerMissing}</output>
        {presentation === "listing" && (
          <div className="mt-6">
            <LinkButton
              as={NextLink}
              href={`/${locale}`}
              size="md"
              theme="outlined"
              variant="secondary"
            >
              {d.home}
            </LinkButton>
          </div>
        )}
      </section>
    );
  }
  return (
    <section
      aria-label={title}
      className={
        presentation === "featured" ? "mx-auto max-w-n1-content py-12 md:py-n1-section" : ""
      }
    >
      {presentation === "featured" && (
        <div className="mb-8 flex items-center gap-4">
          <div className="h-px flex-1 bg-border-primary" />
          <h1 className="text-center text-lg font-bold" id="catalog-title">
            {title}
          </h1>
          <div className="h-px flex-1 bg-border-primary" />
        </div>
      )}
      <div
        className={
          presentation === "featured"
            ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
            : "grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4"
        }
      >
        {catalog.products.map((product) => (
          <ProductCard key={product.id} layout="column" presentation="featured" shadow={false}>
            <div className="h-n1-card-name text-center">
              <ProductCard.Name>
                <Link as={NextLink} href={`/${locale}/produkt/${encodeURIComponent(product.slug)}`}>
                  {product.name}
                </Link>
              </ProductCard.Name>
            </div>
            <div className="mx-auto aspect-square w-full max-w-n1-product-image">
              <Link
                aria-hidden="true"
                as={NextLink}
                href={`/${locale}/produkt/${encodeURIComponent(product.slug)}`}
                tabIndex={-1}
              >
                {product.image === null ? (
                  <div className="flex aspect-square items-center justify-center bg-fill-surface p-4 text-center text-sm text-fg-secondary">
                    {d.imageUnavailable}
                  </div>
                ) : (
                  <ProductCard.Image
                    alt={product.name}
                    as={NextImage}
                    height={256}
                    loading="lazy"
                    objectFit="contain"
                    src={product.image}
                    width={256}
                  />
                )}
              </Link>
            </div>
            <CardVariants
              key={`${locale}:${product.id}:${product.slug}`}
              locale={locale}
              product={product}
            />
            <div className="flex justify-center">
              {product.stock === "unknown" ? (
                <AvailabilityStatus
                  label={d.stock[product.stock]}
                  showIcon={false}
                  status={product.stock}
                />
              ) : (
                <ProductCard.Stock status={stockStatus[product.stock]}>
                  {d.stock[product.stock]}
                </ProductCard.Stock>
              )}
            </div>
            <div className="flex flex-col items-center justify-center gap-0 md:flex-row md:gap-4">
              <PriceBlock {...priceProps(product, d, locale)} />
              {(product.variantCount ?? 0) > 0 ? (
                <LinkButton
                  as={NextLink}
                  density="compact"
                  href={`/${locale}/produkt/${encodeURIComponent(product.slug)}`}
                  size="sm"
                  theme="solid"
                  uppercase
                  variant="secondary"
                >
                  {d.detail}
                </LinkButton>
              ) : (
                <Button
                  aria-label={`${d.addToCart}: ${d.commerceUnavailable}`}
                  density="compact"
                  disabled
                  icon="token-icon-cart"
                  iconPosition="left"
                  size="sm"
                  theme="solid"
                  variant="secondary"
                >
                  {d.addToCart}
                </Button>
              )}
            </div>
          </ProductCard>
        ))}
      </div>
    </section>
  );
};
