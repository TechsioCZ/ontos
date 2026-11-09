"use client";

import { Fragment, useSyncExternalStore } from "react";
import NextImage from "next/image";
import NextLink from "next/link";
import { Gallery } from "@techsio/ui-kit/organisms/gallery";
import { DataTable } from "@techsio/ui-kit/organisms/data-table";
import type { ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { Breadcrumb } from "@techsio/ui-kit/molecules/breadcrumb";
import { Tabs } from "@techsio/ui-kit/molecules/tabs";
import { Link } from "@techsio/ui-kit/atoms/link";
import { Icon } from "@techsio/ui-kit/atoms/icon";
import { AvailabilityStatus } from "@techsio/ui-kit/molecules/availability-status";
import { PriceBlock } from "@techsio/ui-kit/molecules/price-block";
import type { Dictionary } from "@/i18n";
import type { CatalogModel, ProductDetailModel } from "@/ontos/catalog-model";
import { categoryTrail } from "@/ontos/catalog-navigation";
import { priceProps } from "./price-props";
import { ProductPurchase } from "./product-purchase";
import { ProductVariants } from "./product-variants";
import { selectProductDetail } from "./product-selection";
import { useDesktopProduct } from "./product-viewport";
import { productShareHref, productShareOrigin } from "./product-share";

type Parameter = ProductDetailModel["parameters"][number];
const emptyCategories: CatalogModel["categories"] = [];
const mobileInformationOrder = (selectionRequired: boolean) =>
  selectionRequired
    ? { price: "order-1", stock: "order-2" }
    : { price: "order-4", stock: "order-3" };
const parameterColumns = (d: Dictionary, desktop = false): ColumnDef<Parameter>[] => {
  const label: ColumnDef<Parameter> = {
    accessorKey: "label",
    header: d.parameterName,
    id: "label",
  };
  const value: ColumnDef<Parameter> = {
    accessorFn: (row) => (row.unit.length > 0 ? `${row.value} ${row.unit}` : row.value),
    header: d.parameterValue,
    id: "value",
  };
  if (desktop) {
    label.meta = { width: "55%" };
    value.meta = { width: "45%" };
  }
  return [label, value];
};

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
  categories = emptyCategories,
  dictionary: d,
  locale,
  product,
  variantId,
}: {
  categories?: CatalogModel["categories"];
  dictionary: Dictionary;
  locale: string;
  product: ProductDetailModel;
  variantId?: string;
}) => {
  const selection = selectProductDetail(product, variantId);
  const desktop = useDesktopProduct();
  const origin = useSyncExternalStore(
    productShareOrigin.subscribe,
    productShareOrigin.getSnapshot,
    productShareOrigin.getServerSnapshot,
  );
  const { current, genericVariantSelected, images, parameters, selectionRequired, variant } =
    selection;
  const informationOrder = mobileInformationOrder(selectionRequired);
  const category = categories.find((item) => item.id === product.categoryId);
  const trail = category === undefined ? [] : categoryTrail(categories, category.slug);
  const pathname = `/${locale}/produkt/${encodeURIComponent(product.slug)}`;
  const shareHref = productShareHref({
    locale,
    name: product.name,
    origin,
    slug: product.slug,
    variant,
  });
  const questionSearch = new URLSearchParams({ productId: product.id });
  if (variant !== undefined) {
    questionSearch.set("variantIds", variant.id);
  }
  return (
    <article className="mx-auto max-w-n1-product-content p-4 md:py-6">
      <Breadcrumb aria-label={d.catalog} size="md">
        <Breadcrumb.List>
          <Breadcrumb.Item>
            <Breadcrumb.Link as={NextLink} href={`/${locale}`}>
              {d.home}
            </Breadcrumb.Link>
          </Breadcrumb.Item>
          {trail.map((item) => (
            <Fragment key={item.id}>
              <Breadcrumb.Separator />
              <Breadcrumb.Item>
                <Breadcrumb.Link
                  as={NextLink}
                  href={`/${locale}/kategorie/${encodeURIComponent(item.slug)}`}
                >
                  {item.name}
                </Breadcrumb.Link>
              </Breadcrumb.Item>
            </Fragment>
          ))}
          <Breadcrumb.Separator />
          <Breadcrumb.Item>
            <Breadcrumb.CurrentLink>{product.name}</Breadcrumb.CurrentLink>
          </Breadcrumb.Item>
        </Breadcrumb.List>
      </Breadcrumb>
      <div className="relative my-8 md:my-6">
        <h1 className="text-2xl font-bold leading-normal md:text-xl md:leading-9">
          {product.name}
          {variant && !genericVariantSelected && (
            <span className="hidden md:inline">{` – ${variant.name}`}</span>
          )}
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
        <div className="flex min-w-0 flex-col gap-6 md:gap-0">
          {product.manufacturer !== undefined && product.manufacturer.length > 0 && (
            <div className="order-0">
              <p className="font-medium md:hidden">
                {d.manufacturer}: {product.manufacturer}
              </p>
              <dl className="hidden flex-wrap justify-between gap-2 text-fg-secondary md:flex">
                <dt>{d.manufacturer}</dt>
                <dd>{product.manufacturer}</dd>
              </dl>
            </div>
          )}
          <dl className="order-0 hidden flex-wrap justify-between gap-2 text-fg-secondary md:mb-4 md:flex">
            <dt>{d.productCode}</dt>
            <dd>{current.sku.length > 0 ? current.sku : d.productCodeMissing}</dd>
          </dl>
          {product.variants.length > 0 && !genericVariantSelected && (
            <ProductVariants
              desktop={desktop}
              dictionary={d}
              pathname={pathname}
              selectedVariant={variant}
              variants={product.variants}
            />
          )}
          <div className={`${informationOrder.stock} md:order-2 md:mb-6`}>
            <div className="n1-product-stock-desktop hidden md:block">
              <AvailabilityStatus
                label={productStockLabel(selection, d, locale)}
                showIcon={false}
                status={selectionRequired ? "unknown" : current.stock}
              />
            </div>
            <div className="md:hidden">
              <AvailabilityStatus
                label={productStockLabel(selection, d, locale)}
                status={selectionRequired ? "unknown" : current.stock}
              />
            </div>
          </div>
          <div
            aria-hidden="true"
            className="order-3 hidden h-px bg-border-primary md:mb-3 md:block"
          />
          <div className="contents md:order-4 md:mb-4 md:flex md:items-center md:justify-between md:gap-4">
            {variant && !genericVariantSelected && (
              <p className="order-2 font-semibold md:order-none md:font-normal">
                <span className="md:font-bold">{d.selectedVariant}: </span>
                {variant.name}
              </p>
            )}
            <div className="hidden md:ml-auto md:block">
              <Link as={NextLink} href={`/${locale}/doprava`}>
                {d.shippingOptions}
              </Link>
            </div>
          </div>
          <div className={`${informationOrder.price} md:order-5 md:mb-n1-product-price-quantity`}>
            <PriceBlock {...priceProps(current, d, locale, current.priceExcludingVatMinor)} />
          </div>
          <div className="order-5 md:hidden">
            <Link as={NextLink} href={`/${locale}/doprava`}>
              {d.shippingOptions}
            </Link>
          </div>
          <div className="order-6 md:mb-2">
            <ProductPurchase
              dictionary={d}
              locale={locale}
              product={product}
              selection={selection}
            />
          </div>
          <div aria-hidden="true" className="order-7 hidden h-px bg-border-primary md:block" />
          <div className="order-8 flex flex-col items-start gap-6 md:mt-4 md:flex-row md:flex-wrap md:items-center md:gap-x-4 md:gap-y-2">
            <div className="flex items-center gap-2">
              <div className="hidden md:block">
                <Icon color="secondary" icon="icon-[mdi--heart-outline]" size="md" />
              </div>
              <Link
                aria-label={`${d.addToFavorites}: ${d.featureUnavailable}`}
                as="button"
                disabled
                title={d.featureUnavailable}
                type="button"
              >
                {d.addToFavorites}
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden md:block">
                <Icon color="secondary" icon="icon-[mdi--paw-outline]" size="md" />
              </div>
              <Link
                aria-label={`${d.watchProduct}: ${d.featureUnavailable}`}
                as="button"
                disabled
                title={d.featureUnavailable}
                type="button"
              >
                {d.watchProduct}
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden md:block">
                <Icon color="secondary" icon="icon-[mdi--help-circle-outline]" size="md" />
              </div>
              <Link
                as={NextLink}
                href={`/${locale}/kontakty?${questionSearch}#contact-form-heading`}
                prefetch={false}
              >
                {d.contact.productQuestion}
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden md:block">
                <Icon color="secondary" icon="icon-[mdi--email-outline]" size="md" />
              </div>
              <Link aria-disabled={shareHref === null} href={shareHref ?? undefined}>
                {d.sendToFriend}
              </Link>
            </div>
          </div>
        </div>
      </div>
      <div className="n1-product-information mt-8 md:mt-1">
        <Tabs defaultValue="parameters" fitted={!desktop} size="md" variant="line">
          <div className="overflow-x-auto md:n1-product-tabs">
            <Tabs.List>
              <Tabs.Trigger value="parameters">
                {desktop ? d.productParameters : d.productParametersTitle}
              </Tabs.Trigger>
              <Tabs.Trigger value="sizes">{desktop ? d.sizeGuide : d.sizeGuideTitle}</Tabs.Trigger>
              <Tabs.Indicator />
            </Tabs.List>
          </div>
          <div className="flex flex-col gap-3 py-8 empty:hidden md:py-3">
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
                      columns={parameterColumns(d, true)}
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
