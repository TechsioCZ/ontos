"use client";

import Image from "next/image";
import StoreLink from "@/components/store-link";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { ProductCard } from "@techsio/ui-kit/molecules/product-card";

import { erpCardSummary, erpCopy, type ErpProduct } from "@/lib/erp-catalogue";
import { useMoney } from "@/ontos/market-context";

/** The shop's catalogue cards for ERP products: no cart or favourite control, these cannot be ordered yet. */
export function ErpProductGrid({ products }: { products: readonly ErpProduct[] }) {
  const { locale } = useMoney();
  return (
    <div className="sf-product-grid" data-sf-product-listing="catalog" data-sf-erp-products="">
      {products.map((product, index) => {
        const href = `/novinky-z-erp/${encodeURIComponent(product.id)}`;
        const summary = erpCardSummary(product, locale);
        const [first] = product.variants;
        return (
          <article className="min-w-0" key={product.id}>
            <ProductCard
              className="sf-product-card sf-catalog-product-card shadow-(--shadow-sm)"
              layout="column"
            >
              <div className="relative">
                <StoreLink
                  aria-label={product.name}
                  className="sf-catalog-product-card__image-link"
                  href={href}
                >
                  <ProductCard.Image
                    as={Image}
                    alt={product.imageAlt}
                    className="sf-catalog-product-card__image"
                    height={480}
                    loading={index < 4 ? "eager" : "lazy"}
                    sizes="(max-width: 359px) 100vw, (max-width: 1100px) 50vw, 234px"
                    src={product.imageSrc}
                    width={480}
                  />
                </StoreLink>
              </div>
              <ProductCard.Name className="sf-catalog-product-card__name m-0 text-center uppercase">
                <StoreLink className="sf-product-card__name-link" href={href}>
                  {product.name}
                </StoreLink>
              </ProductCard.Name>
              <div className="sf-product-card__stock-row flex flex-wrap items-center justify-between gap-2 py-1">
                <ProductCard.Stock
                  className="sf-catalog-product-card__stock m-0 uppercase"
                  status={summary.stockTone}
                >
                  {summary.stockLabel}
                </ProductCard.Stock>
                {product.variants.length > 1 && (
                  <Badge className="whitespace-nowrap" size="sm" variant="secondary">
                    {`${erpCopy.variants}: ${product.variants.length}`}
                  </Badge>
                )}
              </div>
              <p className="sf-product-card__description m-0 line-clamp-2 min-h-[2.8em] text-sm leading-normal text-(--color-fg-secondary)">
                {product.descriptionParagraphs[0] ??
                  (first?.sku ? `${erpCopy.sku}: ${first.sku}` : "")}
              </p>
              <ProductCard.Price data-sf-product-price className="mt-auto mb-0 text-center">
                {summary.priceLabel}
              </ProductCard.Price>
              <p className="sf-product-card__description m-0 text-center text-xs text-(--color-fg-secondary)">
                {erpCopy.orderNote}
              </p>
            </ProductCard>
          </article>
        );
      })}
    </div>
  );
}
