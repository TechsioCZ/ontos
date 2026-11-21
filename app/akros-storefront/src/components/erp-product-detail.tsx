"use client";

import Image from "next/image";
import { Badge } from "@techsio/ui-kit/atoms/badge";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
import { Table } from "@techsio/ui-kit/organisms/table";

import { StorefrontBreadcrumbs } from "@/components/storefront-breadcrumbs";
import {
  erpCardSummary,
  erpCopy,
  erpPriceLabel,
  erpStockLabel,
  erpAvailabilityStatus,
  isYourPrice,
  type ErpProduct,
} from "@/lib/erp-catalogue";
import { useDictionary, useMoney } from "@/ontos/market-context";

/** One ERP product in the shop's product-detail layout, with its variants' ERP prices and stock. No cart control. */
export function ErpProductDetail({ product }: { product: ErpProduct }) {
  const cs = useDictionary();
  const { locale } = useMoney();
  const summary = erpCardSummary(product, locale);
  const [single] = product.variants.length === 1 ? product.variants : [];
  return (
    <>
      <StorefrontBreadcrumbs
        className="sf-product-detail-breadcrumb"
        items={[
          { href: "/", label: cs.header.home },
          { href: "/novinky-z-erp", label: erpCopy.title },
          { label: product.name },
        ]}
      />
      <article className="sf-product-detail" data-sf-erp-product={product.id}>
        <section className="sf-product-detail__overview" aria-labelledby="product-title">
          <div className="sf-product-detail__gallery">
            <Image
              alt={product.imageAlt}
              className="sf-product-detail__image sf-product-detail__image--primary"
              height={824}
              priority
              sizes="(max-width: 760px) 100vw, 50vw"
              src={product.imageSrc}
              width={1000}
            />
          </div>
          <div className="sf-product-detail__summary">
            <header className="sf-product-detail__heading">
              <h1 id="product-title">{product.name}</h1>
              <Badge className="sf-product-detail__variant-badge" size="md" variant="secondary">
                {erpCopy.title}
              </Badge>
            </header>
            <dl className="sf-product-detail__facts">
              {single?.sku && (
                <div>
                  <dt>{erpCopy.sku}</dt>
                  <dd>{single.sku}</dd>
                </div>
              )}
              {product.categories.length > 0 && (
                <div>
                  <dt>{erpCopy.categories}</dt>
                  <dd>{product.categories.join(", ")}</dd>
                </div>
              )}
              {product.variants.length > 1 && (
                <div>
                  <dt>{erpCopy.variantCount}</dt>
                  <dd>{product.variants.length.toLocaleString(locale)}</dd>
                </div>
              )}
            </dl>
            <p
              className={`sf-product-detail__stock sf-product-detail__stock--${summary.stockTone === "in-stock" ? "available" : summary.stockTone === "out-of-stock" ? "unavailable" : "limited"}`}
            >
              {summary.stockLabel}
            </p>
            <div className="sf-product-detail__buying">
              <p className="sf-product-detail__price-row sf-product-detail__price-row--total">
                <span>{cs.product.price}</span>
                <strong>{summary.priceLabel}</strong>
              </p>
              {summary.yourPrice && (
                <p className="m-0 text-sm text-(--color-fg-secondary)" data-sf-erp-your-price="">
                  {erpCopy.yourPrice}
                </p>
              )}
              <p className="sf-product-detail__price-reason" role="note">
                {erpCopy.orderNote}
              </p>
            </div>
          </div>
        </section>

        <section className="sf-product-detail__description" aria-labelledby="erp-variants-title">
          <h2 id="erp-variants-title">{erpCopy.variants}</h2>
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{erpCopy.variant}</Table.ColumnHeader>
                <Table.ColumnHeader>{erpCopy.sku}</Table.ColumnHeader>
                <Table.ColumnHeader>{erpCopy.options}</Table.ColumnHeader>
                <Table.ColumnHeader numeric>{erpCopy.price}</Table.ColumnHeader>
                <Table.ColumnHeader>{erpCopy.availability}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {product.variants.map((variant) => (
                <Table.Row key={variant.id} data-sf-erp-variant={variant.id}>
                  <Table.Cell>{variant.name}</Table.Cell>
                  <Table.Cell>{variant.sku ?? ""}</Table.Cell>
                  <Table.Cell>{variant.options.join(", ")}</Table.Cell>
                  <Table.Cell
                    numeric
                    className="whitespace-nowrap tabular-nums"
                    data-sf-erp-price=""
                  >
                    {erpPriceLabel(variant.price, locale)}
                    {isYourPrice(variant.price) && (
                      <span
                        className="block text-xs text-(--color-fg-secondary)"
                        data-sf-erp-your-price=""
                      >
                        {erpCopy.yourPrice}
                      </span>
                    )}
                  </Table.Cell>
                  <Table.Cell data-sf-erp-stock="">
                    <AvailabilityStatus
                      label={erpStockLabel(variant.stock, locale)}
                      status={erpAvailabilityStatus(variant.stock)}
                    />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </section>

        <section className="sf-product-detail__description" aria-labelledby="erp-description-title">
          <h2 id="erp-description-title">{erpCopy.description}</h2>
          {product.descriptionParagraphs.length > 0 ? (
            product.descriptionParagraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)
          ) : (
            <p>{erpCopy.descriptionUnavailable}</p>
          )}
        </section>
      </article>
    </>
  );
}
