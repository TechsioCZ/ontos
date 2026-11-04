"use client";

import NextImage from "next/image";
import NextLink from "next/link";
import { Gallery } from "@techsio/ui-kit/organisms/gallery";
import { DataTable } from "@techsio/ui-kit/organisms/data-table";
import type { ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { Breadcrumb } from "@techsio/ui-kit/molecules/breadcrumb";
import { Tabs } from "@techsio/ui-kit/molecules/tabs";
import { LinkButton } from "@techsio/ui-kit/atoms/link-button";
import { Link } from "@techsio/ui-kit/atoms/link";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import type { Dictionary } from "@/i18n";
import type { ProductDetailModel } from "@/ontos/catalog-model";
import { priceProps } from "./price-props";
import { ProductPurchase } from "./product-purchase";
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

const productStockLabel = (
  { current, selectionRequired }: ReturnType<typeof selectProductDetail>,
  d: Dictionary,
  locale: string,
) => {
  if (selectionRequired) {
    return d.stock.unknown;
  }
  const status = d.stock[current.stock];
  if (
    current.stockQuantity === null ||
    (current.stock !== "available" && current.stock !== "limited")
  ) {
    return status;
  }
  const quantity = new Intl.NumberFormat(locale === "en" ? "en-GB" : "cs-CZ", {
    maximumFractionDigits: 20,
  }).format(current.stockQuantity);
  return d.stockWithQuantity
    .replace("{status}", () => status)
    .replace("{quantity}", () => quantity)
    .replace("{unit}", () => current.unit)
    .trim();
};

/** Actual owner selection adds an unverified draft; only an owner quote confirms prices. */
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
  const selection = selectProductDetail(product, variantId);
  const { current, images, parameters, selectionRequired, variant } = selection;
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
      <div className="relative my-8 md:my-6">
        <h1 className="text-2xl font-bold leading-normal md:text-xl md:leading-9">
          {product.name}
          {variant && <span className="hidden md:inline">{` – ${variant.name}`}</span>}
        </h1>
        <div aria-hidden="true" className="absolute bottom-0 hidden h-1 w-24 bg-primary md:block" />
      </div>
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
        <div className="flex min-w-0 flex-col gap-6 md:gap-4">
          {current.sku.length > 0 && (
            <dl className="order-0 hidden flex-wrap justify-between gap-2 text-fg-secondary md:flex">
              <dt>{d.productCode}</dt>
              <dd>{current.sku}</dd>
            </dl>
          )}
          {product.variants.length > 0 && (
            <fieldset className="order-1">
              <legend className="mb-2 font-bold">{d.selectVariant}</legend>
              <div className="flex flex-wrap gap-2">
                {product.variants.map((item) => (
                  <div key={item.id}>
                    <div className="hidden md:block">
                      <LinkButton
                        aria-current={item.id === variant?.id ? "true" : undefined}
                        as={NextLink}
                        href={`${pathname}?${new URLSearchParams({ variantId: item.id })}`}
                        prefetch={false}
                        size="sm"
                        theme="outlined"
                        variant="secondary"
                      >
                        {item.name}
                      </LinkButton>
                    </div>
                    <div className="md:hidden">
                      <LinkButton
                        aria-current={item.id === variant?.id ? "true" : undefined}
                        as={NextLink}
                        href={`${pathname}?${new URLSearchParams({ variantId: item.id })}`}
                        prefetch={false}
                        size="md"
                        theme={item.id === variant?.id ? "solid" : "outlined"}
                        variant={item.id === variant?.id ? "primary" : "secondary"}
                      >
                        {item.name}
                      </LinkButton>
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>
          )}
          <div className="order-3 md:order-2">
            <AvailabilityStatus
              label={productStockLabel(selection, d, locale)}
              status={selectionRequired ? "unknown" : current.stock}
            />
          </div>
          <div aria-hidden="true" className="order-3 hidden h-px bg-border-primary md:block" />
          <div className="contents md:order-4 md:flex md:items-center md:justify-between md:gap-4">
            {variant && (
              <p className="order-2 md:order-none">
                <strong>{d.selectedVariant}: </strong>
                {variant.name}
              </p>
            )}
            <div className="hidden md:ml-auto md:block">
              <Link as={NextLink} href={`/${locale}/doprava`}>
                {d.shippingOptions}
              </Link>
            </div>
          </div>
          <div className="order-4 md:order-5">
            <PriceBlock {...priceProps(current, d, locale, current.priceExcludingVatMinor)} />
          </div>
          <div className="order-5 md:hidden">
            <Link as={NextLink} href={`/${locale}/doprava`}>
              {d.shippingOptions}
            </Link>
          </div>
          <div className="order-6">
            <ProductPurchase
              dictionary={d}
              locale={locale}
              product={product}
              selection={selection}
            />
          </div>
          <div aria-hidden="true" className="order-7 hidden h-px bg-border-primary md:block" />
        </div>
      </div>
      <div className="mt-8 md:mt-1">
        <Tabs defaultValue="parameters" size="md" variant="line">
          <div className="overflow-x-auto md:n1-product-tabs">
            <Tabs.List>
              <Tabs.Trigger value="parameters">{d.productParameters}</Tabs.Trigger>
              <Tabs.Trigger value="sizes">{d.sizeGuide}</Tabs.Trigger>
              <Tabs.Indicator />
            </Tabs.List>
          </div>
          <div className="flex flex-col gap-3 py-3">
            {product.paragraphs.map((paragraph) => (
              <p className="whitespace-pre-line" key={paragraph}>
                {paragraph}
              </p>
            ))}
          </div>
          <Tabs.Content value="parameters">
            <div className="flex flex-col gap-2">
              {parameters.length > 0 && (
                <>
                  <h2 className="hidden text-n1-product-section font-bold leading-7 md:block">
                    {d.productParameters}
                  </h2>
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
                  <div className="n1-product-parameters hidden md:block">
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
            <div className="flex flex-col gap-6 p-4">
              <h2 className="text-xl font-semibold leading-9">{d.sizeGuideTitle}</h2>
              <p className="text-md leading-6">{d.sizeGuideUnavailable}</p>
            </div>
          </Tabs.Content>
        </Tabs>
      </div>
    </article>
  );
};
