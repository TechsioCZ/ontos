"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { Table } from "@techsio/ui-kit/organisms/table";
import { ProductVariantLink } from "@/components/product-variant-link";

import { useCart } from "@/features/cart/cart-provider";
import { useDictionary, useFormatPrice, useMoney } from "@/ontos/market-context";
import type { Dictionary } from "@/i18n";
import { getVariantRangeFilters, type NumericRange } from "@/lib/product-variant-filters";
import { VariantRangeFilter } from "./variant-range-filter";
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import { getMaximumOrderQuantity } from "@/features/cart/cart-state";
import type { CatalogPurchaseProduct, CatalogPurchaseVariant } from "@/ontos/catalog-types";

interface ProductPurchaseFormProps {
  product: CatalogPurchaseProduct;
  variant?: CatalogPurchaseVariant;
  variants?: CatalogPurchaseVariant[];
  initialVariantSearch?: string;
}

const variantListOnlyClassName =
  "hidden @min-sf-variant-list/sf-variants:@max-sf-variant-table/sf-variants:block";
const noVariants: CatalogPurchaseVariant[] = [];
const variantCollator = new Intl.Collator("cs-CZ", {
  numeric: true,
  sensitivity: "base",
});

const formatVariantLabel = (variant: CatalogPurchaseVariant) => {
  const dimension = variant.label.match(/\bM\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/i);
  if (!dimension) return variant.label;

  return `M ${dimension[1]} × ${dimension[2]}`;
};

const variantAvailabilityLabel = (cs: Dictionary, variant: CatalogPurchaseVariant): string =>
  variant.availabilityUnknown
    ? cs.product.variantAvailability.unknown
    : variant.stockCount >= variant.minimumQuantity
      ? cs.product.variantAvailability.inStock
      : cs.product.variantAvailability.outOfStock;

const getVariantCartItem = (product: CatalogPurchaseProduct, variant: CatalogPurchaseVariant) => ({
  vatRate: product.vatRate,
  productId: product.id,
  variantId: variant.id,
  slug: product.slug,
  name: product.name,
  sku: variant.sku,
  imageSrc: variant.imageSrc ?? product.imageSrc,
  imageAlt: product.imageAlt,
  unit: variant.unit,
  minimumQuantity: variant.minimumQuantity,
  quantityStep: variant.quantityStep,
  stockCount: variant.stockCount,
  priceMinor: variant.priceMinor,
  priceExcludingVatMinor: variant.priceTiers.find((tier) => tier.priceMinor === variant.priceMinor)
    ?.priceExcludingVatMinor,
  variantLabel: formatVariantLabel(variant),
  // kg per sales unit from the source feed index; the server quote refreshes it from OntOS projection.
  ...(variant.sourceNetWeight ? { unitWeightKg: variant.sourceNetWeight } : {}),
});

interface VariantOrderControlProps {
  mode: "minimum" | "package";
  onAdd: (variant: CatalogPurchaseVariant, quantity: number) => void;
  product: CatalogPurchaseProduct;
  variant: CatalogPurchaseVariant;
}

function VariantOrderControl({ mode, onAdd, product, variant }: VariantOrderControlProps) {
  const cs = useDictionary();
  const money = useMoney();
  const inputId = useId();
  const isPackage = mode === "package";
  const packageQuantity = variant.packageQuantity ?? variant.minimumQuantity;
  const maximumOrderQuantity = getMaximumOrderQuantity(getVariantCartItem(product, variant));
  const maximum = isPackage
    ? Math.floor(maximumOrderQuantity / packageQuantity)
    : maximumOrderQuantity;
  const minimum = isPackage
    ? variant.quantityStep
      ? Math.ceil(variant.minimumQuantity / packageQuantity)
      : 0
    : variant.minimumQuantity;
  const step = isPackage ? 1 : (variant.quantityStep ?? variant.minimumQuantity);
  const [selectedQuantity, setSelectedQuantity] = useState(minimum);
  const quantityToAdd = isPackage
    ? Math.max(selectedQuantity, 1) * packageQuantity
    : selectedQuantity;
  const label = formatVariantLabel(variant);
  const disabled =
    maximum <= 0 ||
    variant.priceMinor <= 0 ||
    !!variant.priceUnavailableReason ||
    !!variant.availabilityUnknown;

  return (
    <div
      className={`sf-variant-table__order sf-variant-table__order--${mode} @max-sf-variant-table/sf-variants:grid-cols-[var(--sf-variant-table-compact-quantity-width)_minmax(0,1fr)]! @max-sf-variant-table/sf-variants:gap-(--dimension-8)! @max-sf-variant-table/sf-variants:border-0! @max-sf-variant-table/sf-variants:px-(--dimension-0)!`}
    >
      <NumericInput
        id={inputId}
        locale="cs-CZ"
        max={maximum}
        min={minimum}
        onChange={setSelectedQuantity}
        size="sm"
        step={step}
        value={selectedQuantity}
      >
        <NumericInput.Control className="sf-variant-table__quantity-control @max-sf-variant-table/sf-variants:grid-cols-[var(--dimension-44)_minmax(0,1fr)_var(--dimension-44)]!">
          <NumericInput.DecrementTrigger
            aria-label={isPackage ? cs.product.decrementPackages : cs.product.decrementQuantity}
            icon="token-icon-minus"
          />
          <NumericInput.Input
            aria-label={isPackage ? cs.product.packagesOf(label) : cs.product.quantityOf(label)}
          />
          <NumericInput.IncrementTrigger
            aria-label={isPackage ? cs.product.incrementPackages : cs.product.incrementQuantity}
            icon="token-icon-plus"
          />
        </NumericInput.Control>
      </NumericInput>
      <Button
        aria-label={isPackage ? cs.product.buyPackageOf(label) : cs.product.buyItem(label)}
        block={!isPackage}
        className={
          isPackage
            ? "sf-variant-table__buy-button sf-variant-table__buy-button--package w-(--sf-variant-table-package-button-width) max-w-full justify-self-end"
            : "sf-variant-table__buy-button @max-sf-variant-table/sf-variants:min-h-(--dimension-44) @max-sf-variant-table/sf-variants:whitespace-normal! @max-sf-variant-table/sf-variants:[&>span]:flex-col! @max-sf-variant-table/sf-variants:[&>span]:items-center! @max-sf-variant-table/sf-variants:[&>span]:leading-(--sf-variant-table-compact-button-line-height)! @max-sf-variant-table/sf-variants:[&_small]:text-xs!"
        }
        disabled={disabled}
        onClick={() => onAdd(variant, quantityToAdd)}
        size="sm"
        uppercase
        variant={isPackage ? "secondary" : "primary"}
      >
        {isPackage ? (
          <span>
            {cs.variants.buyWhole}
            <br />
            {cs.variants.wholePackage}{" "}
            <small>
              ({packageQuantity.toLocaleString(money.locale)} {variant.unit})
            </small>
          </span>
        ) : (
          <span>
            {cs.product.buy} <small>({variant.unit})</small>
          </span>
        )}
      </Button>
    </div>
  );
}

export function ProductPurchaseForm({
  product,
  variant,
  variants,
  initialVariantSearch,
}: ProductPurchaseFormProps) {
  const { addItem, adding } = useCart();
  const cs = useDictionary();
  const formatPrice = useFormatPrice();
  const sourceVariants = variants ?? noVariants;
  // Only dimensions read reliably from the source labels/parameters become filters; they apply live.
  const filters = useMemo(
    () => getVariantRangeFilters(product, sourceVariants),
    [product, sourceVariants],
  );
  const [ranges, setRanges] = useState<Record<string, NumericRange>>({});
  const [filterRevision, setFilterRevision] = useState(0);
  const [quantity, setQuantity] = useState(variant?.minimumQuantity ?? product.minimumQuantity);
  const normalizedSearchTerm = normalizeCatalogSearchTerm(initialVariantSearch ?? "");
  const visibleVariants = useMemo(
    () =>
      sourceVariants
        .filter(
          (item) =>
            (!normalizedSearchTerm || matchesProductVariantSearch(item, normalizedSearchTerm)) &&
            filters.every((filter) => {
              const range = ranges[filter.id];
              const value = filter.values.get(item.id);
              return !range || (value !== undefined && value >= range[0] && value <= range[1]);
            }),
        )
        .sort((left, right) =>
          variantCollator.compare(formatVariantLabel(left), formatVariantLabel(right)),
        ),
    [sourceVariants, normalizedSearchTerm, filters, ranges],
  );
  const addVariant = useCallback(
    (variant: CatalogPurchaseVariant, selectedQuantity: number) => {
      void addItem(getVariantCartItem(product, variant), selectedQuantity, variant.priceTiers);
    },
    [addItem, product],
  );

  if (!variants?.length) {
    const purchaseItem = variant ?? product;
    // kg per sales unit (source feed index); absent stays unknown.
    const unitWeightKg = variant ? variant.sourceNetWeight : product.netWeight;
    const productCartItem = {
      vatRate: product.vatRate,
      productId: product.id,
      variantId: variant?.id,
      slug: product.slug,
      name: product.name,
      sku: purchaseItem.sku,
      imageSrc: variant?.imageSrc ?? product.imageSrc,
      imageAlt: product.imageAlt,
      unit: purchaseItem.unit,
      minimumQuantity: purchaseItem.minimumQuantity,
      quantityStep: purchaseItem.quantityStep,
      stockCount: purchaseItem.stockCount,
      priceMinor: purchaseItem.priceMinor,
      priceExcludingVatMinor: (variant?.priceTiers ?? product.detail.priceTiers).find(
        (tier) => tier.priceMinor === purchaseItem.priceMinor,
      )?.priceExcludingVatMinor,
      variantLabel: variant ? formatVariantLabel(variant) : undefined,
      ...(unitWeightKg ? { unitWeightKg } : {}),
    };
    const maximumQuantity = getMaximumOrderQuantity(productCartItem);

    return (
      <div className="sf-purchase-form">
        {purchaseItem.quantityStep && (
          <small className="col-span-full text-fg-secondary">
            {cs.product.wholePackagesOnly(
              purchaseItem.packageQuantity ?? purchaseItem.quantityStep,
              purchaseItem.unit,
            )}
          </small>
        )}
        <NumericInput
          id={`quantity-${product.id}`}
          locale="cs-CZ"
          min={purchaseItem.minimumQuantity}
          max={maximumQuantity}
          step={purchaseItem.quantityStep ?? purchaseItem.minimumQuantity}
          onChange={setQuantity}
          size="lg"
          value={quantity}
        >
          <NumericInput.Control className="sf-purchase-form__quantity-control">
            <NumericInput.DecrementTrigger
              aria-label={cs.product.decrementQuantity}
              className="sf-purchase-form__quantity-trigger h-full"
              icon="token-icon-minus"
            />
            <NumericInput.Input aria-label={cs.cart.quantity} />
            <NumericInput.IncrementTrigger
              aria-label={cs.product.incrementQuantity}
              className="sf-purchase-form__quantity-trigger h-full"
              icon="token-icon-plus"
            />
          </NumericInput.Control>
        </NumericInput>
        <Button
          block
          disabled={
            adding ||
            maximumQuantity <= 0 ||
            purchaseItem.priceMinor <= 0 ||
            !!purchaseItem.priceUnavailableReason ||
            !!purchaseItem.availabilityUnknown
          }
          title={
            purchaseItem.priceUnavailableReason
              ? cs.product.priceUnavailableTitle(purchaseItem.priceUnavailableReason)
              : purchaseItem.availabilityUnknown
                ? cs.product.availabilityUnknownTitle
                : undefined
          }
          icon="token-icon-cart"
          onClick={() => {
            void addItem(
              productCartItem,
              quantity,
              variant?.priceTiers ?? product.detail.priceTiers,
            );
          }}
          size="md"
          uppercase
          variant="primary"
        >
          {cs.product.buy}
        </Button>
      </div>
    );
  }

  return (
    <div className="sf-variant-purchase @container/sf-variants">
      {filters.length > 0 && (
        <section className="w-full max-w-full rounded-sm border-(length:--border-sm) border-base-dark bg-base p-(--sf-variant-filter-padding) md:w-fit md:@max-sf-variant-table/sf-variants:w-full">
          <form
            aria-label={cs.product.variantFilters}
            className="sf-variant-purchase__filter-bar flex flex-col gap-y-(--dimension-12) md:flex-row md:flex-wrap md:items-baseline-last"
            onSubmit={(event) => event.preventDefault()}
          >
            {filters.map((filter) => (
              <VariantRangeFilter
                key={filter.id + filterRevision}
                filter={filter}
                value={ranges[filter.id] ?? filter.bounds}
                onChange={(value) =>
                  setRanges((current) => {
                    const previous = current[filter.id] ?? filter.bounds;
                    return previous[0] === value[0] && previous[1] === value[1]
                      ? current
                      : { ...current, [filter.id]: value };
                  })
                }
              />
            ))}
            <Button
              type="button"
              size="sm"
              theme="outlined"
              variant="secondary"
              onClick={() => {
                setRanges({});
                setFilterRevision((revision) => revision + 1);
              }}
            >
              {cs.variants.resetFilters}
            </Button>
          </form>
        </section>
      )}
      <output className="block m-0 text-sm text-fg-secondary">
        {cs.variants.shown(visibleVariants.length, sourceVariants.length)}
      </output>

      <>
        <div className="sf-variant-data-table flex w-full flex-col overflow-hidden rounded-data-table border-(length:--border-width-data-table) border-data-table-border">
          <div className="relative w-full overflow-auto">
            <Table
              aria-label={cs.product.variantsTitle}
              aria-rowcount={visibleVariants.length + 1}
              className="sf-variant-data-table__table @max-sf-variant-table/sf-variants:block @max-sf-variant-table/sf-variants:[&_thead]:sr-only @max-sf-variant-table/sf-variants:[&_tbody]:grid @max-sf-variant-table/sf-variants:[&_tbody]:min-w-0 @max-sf-variant-table/sf-variants:[&_tbody]:gap-(--dimension-12)"
              showColumnBorder
              size="sm"
              style={{ tableLayout: "fixed" }}
              variant="line"
            >
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader
                    className="group/header relative"
                    style={{
                      width: "auto",
                      backgroundColor: "var(--color-data-table-bg)",
                      backgroundImage:
                        "linear-gradient(var(--color-data-table-header-bg), var(--color-data-table-header-bg))",
                    }}
                  >
                    <div className="inline-flex items-center gap-100 whitespace-nowrap">
                      {cs.product.table.name}
                    </div>
                  </Table.ColumnHeader>
                  <Table.ColumnHeader
                    className="group/header relative"
                    style={{
                      width: "16%",
                      backgroundColor: "var(--color-data-table-bg)",
                      backgroundImage:
                        "linear-gradient(var(--color-data-table-header-bg), var(--color-data-table-header-bg))",
                    }}
                  >
                    <div className="inline-flex items-center gap-100 whitespace-nowrap">
                      {cs.product.table.code}
                    </div>
                  </Table.ColumnHeader>
                  <Table.ColumnHeader
                    align="center"
                    className="group/header relative"
                    style={{
                      width: "4%",
                      backgroundColor: "var(--color-data-table-bg)",
                      backgroundImage:
                        "linear-gradient(var(--color-data-table-header-bg), var(--color-data-table-header-bg))",
                    }}
                  >
                    <div className="inline-flex items-center gap-100 whitespace-nowrap">
                      {cs.product.table.unit}
                    </div>
                  </Table.ColumnHeader>
                  <Table.ColumnHeader
                    className="group/header relative"
                    style={{
                      width: "9%",
                      backgroundColor: "var(--color-data-table-bg)",
                      backgroundImage:
                        "linear-gradient(var(--color-data-table-header-bg), var(--color-data-table-header-bg))",
                    }}
                  >
                    <div className="inline-flex items-center gap-100 whitespace-nowrap">
                      {cs.product.table.availability}
                    </div>
                  </Table.ColumnHeader>
                  <Table.ColumnHeader
                    className="group/header relative"
                    style={{
                      width: "12%",
                      backgroundColor: "var(--color-data-table-bg)",
                      backgroundImage:
                        "linear-gradient(var(--color-data-table-header-bg), var(--color-data-table-header-bg))",
                    }}
                  >
                    <div className="inline-flex items-center gap-100 whitespace-nowrap">
                      {cs.product.table.price}
                    </div>
                  </Table.ColumnHeader>
                  <Table.ColumnHeader
                    align="center"
                    className="group/header relative"
                    style={{
                      width: "var(--sf-variant-table-purchase-column-width)",
                      backgroundColor: "var(--color-data-table-bg)",
                      backgroundImage:
                        "linear-gradient(var(--color-data-table-header-bg), var(--color-data-table-header-bg))",
                    }}
                  >
                    <div className="inline-flex items-center gap-100 whitespace-nowrap">
                      {cs.product.table.quantity}
                    </div>
                  </Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {visibleVariants.map((item, index) => {
                  const label = formatVariantLabel(item);
                  const isAvailable =
                    !item.availabilityUnknown && item.stockCount >= item.minimumQuantity;
                  const basePriceTier = item.priceTiers[0];
                  const packageQuantity = item.packageQuantity ?? item.minimumQuantity;
                  const hasSeparatePackage =
                    packageQuantity > item.minimumQuantity || !!item.quantityStep;
                  return (
                    <Table.Row
                      key={item.id}
                      aria-rowindex={index + 2}
                      className="sf-variant-data-table__row"
                    >
                      <Table.Cell style={{ width: "auto" }}>
                        <div className="sf-variant-table__name min-w-0">
                          <strong className="min-w-0 whitespace-normal wrap-anywhere @max-sf-variant-table/sf-variants:text-(length:--text-base)!">
                            <ProductVariantLink
                              slug={product.slug}
                              imageSrc={product.imageSrc}
                              variant={item}
                              label={label}
                            />
                          </strong>
                          <p
                            className={`${variantListOnlyClassName} mt-(--dimension-8) whitespace-nowrap text-xs font-normal text-fg-secondary`}
                          >
                            {cs.product.code}: {item.sku}
                          </p>
                        </div>
                      </Table.Cell>
                      <Table.Cell style={{ width: "16%" }}>
                        <span className="sf-variant-table__sku block whitespace-nowrap @max-sf-variant-table/sf-variants:text-xs @max-sf-variant-table/sf-variants:font-normal @max-sf-variant-table/sf-variants:text-fg-secondary">
                          <span className="sf-variant-table__mobile-label @max-sf-variant-table/sf-variants:inline!">
                            {cs.product.code}:{" "}
                          </span>
                          <span>{item.sku}</span>
                        </span>
                      </Table.Cell>
                      <Table.Cell align="center" style={{ width: "4%" }}>
                        {item.unit}
                      </Table.Cell>
                      <Table.Cell style={{ width: "9%" }}>
                        <strong
                          className="sf-variant-table__availability @max-sf-variant-table/sf-variants:text-xs @max-sf-variant-table/sf-variants:font-normal"
                          data-available={isAvailable}
                          title={
                            item.availabilityUnknown
                              ? cs.product.variantAvailabilityUnknown
                              : undefined
                          }
                        >
                          {variantAvailabilityLabel(cs, item)}
                        </strong>
                      </Table.Cell>
                      <Table.Cell style={{ width: "12%" }}>
                        <div className="sf-variant-table__price min-w-0">
                          <div className={`${variantListOnlyClassName} mb-(--dimension-8)`}>
                            <span
                              className="sf-variant-table__availability text-xs font-normal"
                              data-available={
                                !item.availabilityUnknown && item.stockCount >= item.minimumQuantity
                              }
                            >
                              {variantAvailabilityLabel(cs, item)}
                            </span>
                          </div>
                          {item.priceUnavailableReason ? (
                            <span className="grid gap-1">
                              <strong className="whitespace-normal!">
                                {cs.product.priceUnavailable}
                              </strong>
                              <small className="whitespace-normal! text-xs font-normal text-fg-secondary">
                                {item.priceUnavailableReason}
                              </small>
                            </span>
                          ) : (
                            <>
                              <strong className="min-w-0 whitespace-normal! wrap-anywhere @max-sf-variant-table/sf-variants:text-(length:--text-base)!">
                                {formatPrice(item.priceMinor).replace(/\s(?=\S+$)/u, " ")}
                                <span className="sf-variant-table__mobile-label @max-sf-variant-table/sf-variants:inline! @max-sf-variant-table/sf-variants:text-xs @max-sf-variant-table/sf-variants:font-normal">
                                  {" "}
                                  / {item.unit}
                                </span>
                              </strong>
                              {basePriceTier && (
                                <small className="@max-sf-variant-table/sf-variants:text-xs! @max-sf-variant-table/sf-variants:font-normal">
                                  {formatPrice(basePriceTier.priceExcludingVatMinor)}{" "}
                                  {cs.product.excludingVat}
                                </small>
                              )}
                            </>
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell
                        align="center"
                        style={{ width: "var(--sf-variant-table-purchase-column-width)" }}
                      >
                        <div className="sf-variant-table__purchase-cell @max-sf-variant-table/sf-variants:grid-cols-1! @max-sf-variant-table/sf-variants:gap-(--dimension-8)">
                          {item.quantityStep && (
                            <small className="col-span-full text-fg-secondary">
                              {cs.product.wholePackagesMinimum(
                                packageQuantity,
                                item.unit,
                                item.minimumQuantity,
                              )}
                            </small>
                          )}
                          <VariantOrderControl
                            mode="minimum"
                            onAdd={addVariant}
                            product={product}
                            variant={item}
                          />
                          {hasSeparatePackage ? (
                            <VariantOrderControl
                              mode="package"
                              onAdd={addVariant}
                              product={product}
                              variant={item}
                            />
                          ) : (
                            <span
                              aria-hidden="true"
                              className="sf-variant-table__no-package @max-sf-variant-table/sf-variants:hidden"
                            >
                              —
                            </span>
                          )}
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
                {visibleVariants.length === 0 && (
                  <Table.Row>
                    <Table.Cell colSpan={6}>
                      <p className="sf-variant-purchase__empty">
                        {cs.product.noVariantsForFilters}
                      </p>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table>
          </div>
        </div>
      </>
    </div>
  );
}
