"use client";

import NextImage from "next/image";
import { useState } from "react";
import NextLink from "next/link";
import { Gallery } from "@techsio/ui-kit/organisms/gallery";
import { DataTable } from "@techsio/ui-kit/organisms/data-table";
import type { ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { Breadcrumb } from "@techsio/ui-kit/molecules/breadcrumb";
import { Tabs } from "@techsio/ui-kit/molecules/tabs";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Button } from "@techsio/ui-kit/atoms/button";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import { QuantityField } from "@techsio/ui-kit/molecules/quantity-field";
import type { Dictionary } from "@/i18n";
import type { ProductDetailModel } from "@/ontos/catalog-model";
import { priceProps } from "./price-props";
import { selectProductDetail } from "./product-selection";

type Parameter = ProductDetailModel["parameters"][number];
const parameterColumns = (d: Dictionary): ColumnDef<Parameter>[] => [
  { accessorKey: "label", header: d.parameterName, id: "label" },
  {
    accessorFn: (row) => (row.unit.length > 0 ? `${row.value} ${row.unit}` : row.value),
    header: d.parameterValue,
    id: "value",
  },
];

/** Full owner detail with real variant selection; purchasing remains explicitly unavailable. */
export const ProductView = ({
  dictionary: d,
  locale,
  product,
  variantId,
}: {
  dictionary: Dictionary;
  locale: string;
  product: ProductDetailModel;
  variantId?: string;
}) => {
  const { current, images, parameters, selectionRequired, variant } = selectProductDetail(
    product,
    variantId,
  );
  const [quantity, setQuantity] = useState(String(current.minimumQuantity));
  const pathname = `/${locale}/produkt/${encodeURIComponent(product.slug)}`;
  return (
    <article className="mx-auto max-w-n1-product-content p-4 md:py-6">
      <Breadcrumb aria-label={d.catalog} size="md">
        <Breadcrumb.List>
          <Breadcrumb.Item>
            <Breadcrumb.Link as={NextLink} href={`/${locale}`}>
              {d.home}
            </Breadcrumb.Link>
          </Breadcrumb.Item>
          <Breadcrumb.Separator />
          <Breadcrumb.Item>
            <Breadcrumb.CurrentLink>{product.name}</Breadcrumb.CurrentLink>
          </Breadcrumb.Item>
        </Breadcrumb.List>
      </Breadcrumb>
      <h1 className="my-8 text-2xl font-bold md:my-6 md:text-xl">
        {product.name}
        {variant ? ` – ${variant.name}` : ""}
      </h1>
      <div className="grid gap-8 md:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Gallery
            aria-label={product.name}
            carouselProps={{
              "aria-label": product.name,
              aspectRatio: "square",
              imageAs: NextImage,
              objectFit: "contain",
              size: "full",
            }}
            emptyState={<p className="py-12 text-center text-fg-secondary">{d.imageUnavailable}</p>}
            getThumbnailAriaLabel={({ index }) => `${product.name}: ${d.heroSlide} ${index + 1}`}
            items={images.map((src, index) => ({
              alt: product.imageAlt,
              id: src,
              imageProps: { height: 448, priority: index === 0, width: 448 },
              src,
              thumbnailImageProps: { height: 64, width: 64 },
            }))}
            orientation="horizontal"
            thumbnailImageAs={NextImage}
            thumbnailSize={66}
          >
            <Gallery.Main>
              <Gallery.Carousel />
            </Gallery.Main>
            <Gallery.Thumbnails />
          </Gallery>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          {current.sku.length > 0 && (
            <dl className="flex flex-wrap justify-between gap-2 text-fg-secondary">
              <dt>{d.productCode}</dt>
              <dd>{current.sku}</dd>
            </dl>
          )}
          {product.variants.length > 0 && (
            <fieldset>
              <legend className="mb-2 font-bold">{d.selectVariant}</legend>
              <div className="flex flex-wrap gap-2">
                {product.variants.map((item) => (
                  <LinkButton
                    aria-current={item.id === variant?.id ? "true" : undefined}
                    as={NextLink}
                    href={`${pathname}?${new URLSearchParams({ variantId: item.id })}`}
                    key={item.id}
                    prefetch={false}
                    size="md"
                    theme={item.id === variant?.id ? "solid" : "outlined"}
                    variant={item.id === variant?.id ? "primary" : "secondary"}
                  >
                    {item.name}
                  </LinkButton>
                ))}
              </div>
            </fieldset>
          )}
          <AvailabilityStatus
            label={selectionRequired ? d.selectVariant : d.stock[current.stock]}
            status={selectionRequired ? "unknown" : current.stock}
          />
          {variant && (
            <p>
              <strong>{d.selectedVariant}: </strong>
              {variant.name}
            </p>
          )}
          <PriceBlock {...priceProps(current, d, locale)} />
          <div>
            <div className="mb-4">
              <QuantityField
                disabled
                label={d.quantity}
                min={current.minimumQuantity}
                onValueChange={({ value }) => setQuantity(value)}
                size="md"
                unitLabel={current.unit}
                value={quantity}
              />
            </div>
            <div className="md:hidden">
              <Button
                aria-describedby="purchase-unavailable"
                block
                disabled
                size="md"
                theme="solid"
                variant="primary"
              >
                {d.addToCart}
              </Button>
            </div>
            <div className="hidden md:block">
              <Button
                aria-describedby="purchase-unavailable"
                disabled
                size="md"
                theme="solid"
                variant="secondary"
              >
                {d.addToCart}
              </Button>
            </div>
            <p className="mt-2 text-sm text-fg-secondary" id="purchase-unavailable">
              {d.commerceUnavailable}
            </p>
          </div>
        </div>
      </div>
      <div className="mt-8 md:mt-1">
        <Tabs defaultValue="parameters" size="md" variant="line">
          <div className="overflow-x-auto">
            <Tabs.List>
              <Tabs.Trigger value="parameters">{d.productParameters}</Tabs.Trigger>
              <Tabs.Trigger value="sizes">{d.sizeGuide}</Tabs.Trigger>
              <Tabs.Indicator />
            </Tabs.List>
          </div>
          <Tabs.Content value="parameters">
            <div className="flex flex-col gap-3 py-3">
              {product.paragraphs.map((paragraph) => (
                <p className="whitespace-pre-line" key={paragraph}>
                  {paragraph}
                </p>
              ))}
              {parameters.length > 0 && (
                <>
                  <div className="md:hidden">
                    <DataTable
                      columns={parameterColumns(d)}
                      data={[...parameters]}
                      enableSorting={false}
                      hideHeader
                      size="sm"
                      slotProps={{ root: { "aria-label": d.productParameters } }}
                      variant="line"
                    />
                  </div>
                  <div className="hidden md:block">
                    <DataTable
                      columns={parameterColumns(d)}
                      data={[...parameters]}
                      enableSorting={false}
                      hideHeader
                      size="sm"
                      slotProps={{ root: { "aria-label": d.productParameters } }}
                      variant="striped"
                    />
                  </div>
                </>
              )}
            </div>
          </Tabs.Content>
          <Tabs.Content value="sizes">
            <p className="py-3">{d.sizeGuideUnavailable}</p>
          </Tabs.Content>
        </Tabs>
      </div>
    </article>
  );
};
