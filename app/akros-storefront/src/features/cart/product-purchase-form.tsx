"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { DataTable, type ColumnDef } from "@techsio/ui-kit/organisms/data-table";
import { ProductVariantLink } from "@/components/product-variant-link";

import { useCart } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";
import { getVariantRangeFilters, type NumericRange } from "@/lib/product-variant-filters";
import { VariantRangeFilter } from "./variant-range-filter";
import { formatPrice } from "@/lib/format";
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import { getMaximumOrderQuantity } from "@/mock-storefront/cart";
import type { CatalogProduct, CatalogProductVariant } from "@/mock-storefront/types";

interface ProductPurchaseFormProps {
  product: CatalogProduct;
  variant?: CatalogProductVariant;
  variants?: CatalogProductVariant[];
  initialVariantSearch?: string;
}

const variantListRowClassName =
  "@min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:grid-cols-(--akros-variant-table-list-columns)! @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(1)]:col-span-1! @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(1)]:col-start-1! @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(1)]:row-start-1 @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(2)]:hidden @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(4)]:hidden @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(5)]:col-start-2! @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(5)]:row-start-1! @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(6)]:col-span-1! @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(6)]:col-start-3! @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(6)]:row-start-1 @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(6)]:border-t-0! @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:[&>td:nth-child(6)]:pt-(--dimension-0)!";

const variantListOnlyClassName =
  "hidden @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:block";
const noVariants: CatalogProductVariant[] = [];
const variantCollator = new Intl.Collator("cs-CZ", {
  numeric: true,
  sensitivity: "base",
});
const formatVariantLabel = (variant: CatalogProductVariant) => {
  const dimension = variant.label.match(/\bM\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/i);
  if (!dimension) return variant.label;

  return `M ${dimension[1]} × ${dimension[2]}`;
};

const getVariantCartItem = (product: CatalogProduct, variant: CatalogProductVariant) => ({
  productId: product.id,
  variantId: variant.id,
  slug: product.slug,
  name: product.name,
  sku: variant.sku,
  imageSrc: variant.imageSrc ?? product.imageSrc,
  imageAlt: product.imageAlt,
  unit: variant.unit,
  minimumQuantity: variant.minimumQuantity,
  stockCount: variant.stockCount,
  priceMinor: variant.priceMinor,
  priceExcludingVatMinor: variant.priceTiers.find((tier) => tier.priceMinor === variant.priceMinor)
    ?.priceExcludingVatMinor,
  variantLabel: formatVariantLabel(variant),
});

interface VariantOrderControlProps {
  mode: "minimum" | "package";
  onAdd: (variant: CatalogProductVariant, quantity: number) => void;
  product: CatalogProduct;
  variant: CatalogProductVariant;
}

function VariantOrderControl({ mode, onAdd, product, variant }: VariantOrderControlProps) {
  const inputId = useId();
  const isPackage = mode === "package";
  const packageQuantity = variant.packageQuantity ?? variant.minimumQuantity;
  const maximumOrderQuantity = getMaximumOrderQuantity(getVariantCartItem(product, variant));
  const maximum = isPackage
    ? Math.floor(maximumOrderQuantity / packageQuantity)
    : maximumOrderQuantity;
  const minimum = isPackage ? 0 : variant.minimumQuantity;
  const step = isPackage ? 1 : variant.minimumQuantity;
  const [selectedQuantity, setSelectedQuantity] = useState(minimum);
  const quantityToAdd = isPackage
    ? Math.max(selectedQuantity, 1) * packageQuantity
    : selectedQuantity;
  const label = formatVariantLabel(variant);
  const disabled = maximum <= 0 || variant.priceMinor <= 0;

  return (
    <div
      className={`akros-variant-table__order akros-variant-table__order--${mode} @max-akros-variant-table/akros-variants:grid-cols-[var(--akros-variant-table-compact-quantity-width)_minmax(0,1fr)]! @max-akros-variant-table/akros-variants:gap-(--dimension-8)! @max-akros-variant-table/akros-variants:border-0! @max-akros-variant-table/akros-variants:px-(--dimension-0)!`}
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
        <NumericInput.Control className="akros-variant-table__quantity-control @max-akros-variant-table/akros-variants:grid-cols-[var(--dimension-44)_minmax(0,1fr)_var(--dimension-44)]!">
          <NumericInput.DecrementTrigger
            aria-label={isPackage ? "Snížit počet balení" : "Snížit množství"}
            icon="token-icon-minus"
          />
          <NumericInput.Input
            aria-label={isPackage ? `Počet celých balení ${label}` : `Množství ${label}`}
          />
          <NumericInput.IncrementTrigger
            aria-label={isPackage ? "Zvýšit počet balení" : "Zvýšit množství"}
            icon="token-icon-plus"
          />
        </NumericInput.Control>
      </NumericInput>
      <Button
        aria-label={isPackage ? `Koupit celé balení ${label}` : `Koupit ${label}`}
        block={!isPackage}
        className={
          isPackage
            ? "akros-variant-table__buy-button akros-variant-table__buy-button--package w-(--akros-variant-table-package-button-width) max-w-full justify-self-end"
            : "akros-variant-table__buy-button @max-akros-variant-table/akros-variants:min-h-(--dimension-44) @max-akros-variant-table/akros-variants:whitespace-normal! @max-akros-variant-table/akros-variants:[&>span]:flex-col! @max-akros-variant-table/akros-variants:[&>span]:items-center! @max-akros-variant-table/akros-variants:[&>span]:leading-(--akros-variant-table-compact-button-line-height)! @max-akros-variant-table/akros-variants:[&_small]:text-xs!"
        }
        disabled={disabled}
        onClick={() => onAdd(variant, quantityToAdd)}
        size="sm"
        uppercase
        variant={isPackage ? "secondary" : "primary"}
      >
        {isPackage ? (
          <span>
            Koupit celé
            <br />
            balení{" "}
            <small>
              ({packageQuantity.toLocaleString("cs-CZ")} {variant.unit})
            </small>
          </span>
        ) : (
          <span>
            Koupit <small>({variant.unit})</small>
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
  const { dispatch } = useCart();
  const sourceVariants = variants ?? noVariants;
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
    (variant: CatalogProductVariant, selectedQuantity: number) => {
      dispatch({
        type: "add",
        item: getVariantCartItem(product, variant),
        quantity: selectedQuantity,
      });
    },
    [dispatch, product],
  );
  const variantColumns = useMemo<ColumnDef<CatalogProductVariant, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Název",
        meta: { width: "auto" },
        cell: ({ row }) => {
          const label = formatVariantLabel(row.original);

          return (
            <div className="akros-variant-table__name min-w-0">
              <strong className="min-w-0 whitespace-normal wrap-anywhere @max-akros-variant-table/akros-variants:text-(length:--text-base)!">
                <ProductVariantLink
                  slug={product.slug}
                  imageSrc={product.imageSrc}
                  variant={row.original}
                  label={label}
                />
              </strong>
              <p
                className={`${variantListOnlyClassName} mt-(--dimension-8) whitespace-nowrap text-xs font-normal text-fg-secondary`}
              >
                Kód: {row.original.sku}
              </p>
            </div>
          );
        },
      },
      {
        accessorKey: "sku",
        header: "Kód",
        meta: { width: "16%" },
        cell: ({ row }) => (
          <span className="akros-variant-table__sku block whitespace-nowrap @max-akros-variant-table/akros-variants:text-xs @max-akros-variant-table/akros-variants:font-normal @max-akros-variant-table/akros-variants:text-fg-secondary">
            <span className="akros-variant-table__mobile-label @max-akros-variant-table/akros-variants:inline!">
              Kód:{" "}
            </span>
            <span>{row.original.sku}</span>
          </span>
        ),
      },
      {
        accessorKey: "unit",
        header: "M.J.",
        meta: { align: "center", width: "4%" },
      },
      {
        id: "availability",
        header: "Dostupnost",
        meta: { width: "9%" },
        cell: ({ row }) => {
          const isAvailable = row.original.stockCount >= row.original.minimumQuantity;

          return (
            <strong
              className="akros-variant-table__availability @max-akros-variant-table/akros-variants:text-xs @max-akros-variant-table/akros-variants:font-normal"
              data-available={isAvailable}
            >
              {isAvailable ? "Skladem" : "Není skladem"}
            </strong>
          );
        },
      },
      {
        id: "price",
        header: "Cena",
        meta: { width: "12%" },
        cell: ({ row }) => {
          const basePriceTier = row.original.priceTiers[0];

          return (
            <div className="akros-variant-table__price min-w-0">
              <div className={`${variantListOnlyClassName} mb-(--dimension-8)`}>
                <span
                  className="akros-variant-table__availability text-xs font-normal"
                  data-available={row.original.stockCount >= row.original.minimumQuantity}
                >
                  {row.original.stockCount >= row.original.minimumQuantity
                    ? "Skladem"
                    : "Není skladem"}
                </span>
              </div>
              <strong className="min-w-0 whitespace-normal! wrap-anywhere @max-akros-variant-table/akros-variants:text-(length:--text-base)!">
                {formatPrice(row.original.priceMinor).replace(/\s(?=\S+$)/u, " ")}
                <span className="akros-variant-table__mobile-label @max-akros-variant-table/akros-variants:inline! @max-akros-variant-table/akros-variants:text-xs @max-akros-variant-table/akros-variants:font-normal">
                  {" "}
                  / {row.original.unit}
                </span>
              </strong>
              {basePriceTier && (
                <small className="@max-akros-variant-table/akros-variants:text-xs! @max-akros-variant-table/akros-variants:font-normal">
                  {formatPrice(basePriceTier.priceExcludingVatMinor)} bez DPH
                </small>
              )}
            </div>
          );
        },
      },
      {
        id: "quantity",
        header: "Množství",
        meta: { align: "center", width: "var(--akros-variant-table-purchase-column-width)" },
        cell: ({ row }) => {
          const item = row.original;
          const packageQuantity = item.packageQuantity ?? item.minimumQuantity;
          const hasSeparatePackage = packageQuantity > item.minimumQuantity;

          return (
            <div className="akros-variant-table__purchase-cell @max-akros-variant-table/akros-variants:grid-cols-1! @max-akros-variant-table/akros-variants:gap-(--dimension-8)">
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
                  className="akros-variant-table__no-package @max-akros-variant-table/akros-variants:hidden"
                >
                  —
                </span>
              )}
            </div>
          );
        },
      },
    ],
    [addVariant, product],
  );

  if (!variants?.length) {
    const purchaseItem = variant ?? product;
    const productCartItem = {
      productId: product.id,
      variantId: variant?.id,
      slug: product.slug,
      name: product.name,
      sku: purchaseItem.sku,
      imageSrc: variant?.imageSrc ?? product.imageSrc,
      imageAlt: product.imageAlt,
      unit: purchaseItem.unit,
      minimumQuantity: purchaseItem.minimumQuantity,
      stockCount: purchaseItem.stockCount,
      priceMinor: purchaseItem.priceMinor,
      priceExcludingVatMinor: (variant?.priceTiers ?? product.detail.priceTiers).find(
        (tier) => tier.priceMinor === purchaseItem.priceMinor,
      )?.priceExcludingVatMinor,
      variantLabel: variant ? formatVariantLabel(variant) : undefined,
    };
    const maximumQuantity = getMaximumOrderQuantity(productCartItem);

    return (
      <div className="akros-purchase-form">
        <NumericInput
          id={`quantity-${product.id}`}
          locale="cs-CZ"
          min={purchaseItem.minimumQuantity}
          max={maximumQuantity}
          step={purchaseItem.minimumQuantity}
          onChange={setQuantity}
          size="lg"
          value={quantity}
        >
          <NumericInput.Control className="akros-purchase-form__quantity-control">
            <NumericInput.DecrementTrigger
              aria-label="Snížit množství"
              className="akros-purchase-form__quantity-trigger h-full"
              icon="token-icon-minus"
            />
            <NumericInput.Input aria-label={cs.cart.quantity} />
            <NumericInput.IncrementTrigger
              aria-label="Zvýšit množství"
              className="akros-purchase-form__quantity-trigger h-full"
              icon="token-icon-plus"
            />
          </NumericInput.Control>
        </NumericInput>
        <Button
          block
          disabled={maximumQuantity <= 0 || purchaseItem.priceMinor <= 0}
          icon="token-icon-cart"
          onClick={() => {
            dispatch({
              type: "add",
              item: productCartItem,
              quantity,
            });
          }}
          size="md"
          uppercase
          variant="primary"
        >
          Koupit
        </Button>
      </div>
    );
  }

  return (
    <div className="akros-variant-purchase @container/akros-variants">
      {filters.length > 0 && (
        <section className="w-full max-w-full rounded-sm border-(length:--border-sm) border-base-dark bg-base p-(--akros-variant-filter-padding) md:w-fit md:@max-akros-variant-table/akros-variants:w-full">
          <form
            aria-label="Filtrování variant"
            className="akros-variant-purchase__filter-bar flex flex-col gap-y-(--dimension-12) md:flex-row md:flex-wrap md:items-center"
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
              Obnovit filtry
            </Button>
          </form>
        </section>
      )}
      <output className="block m-0 text-sm text-fg-secondary">
        Zobrazeno {visibleVariants.length} z {sourceVariants.length} variant
      </output>

      <>
        <DataTable
          className="akros-variant-data-table"
          columns={variantColumns}
          data={visibleVariants}
          enableSorting={false}
          getRowId={(item) => item.id}
          renderEmpty={() => (
            <p className="akros-variant-purchase__empty">
              Pro zadané filtry nebyla nalezena varianta.
            </p>
          )}
          showColumnBorder
          size="sm"
          slotProps={{
            root: {
              "aria-label": "Varianty produktu",
              className:
                "akros-variant-data-table__table @max-akros-variant-table/akros-variants:block @max-akros-variant-table/akros-variants:[&_thead]:sr-only @max-akros-variant-table/akros-variants:[&_tbody]:grid @max-akros-variant-table/akros-variants:[&_tbody]:min-w-0 @max-akros-variant-table/akros-variants:[&_tbody]:gap-(--dimension-12)",
            },
            row: {
              className: `akros-variant-data-table__row @max-akros-variant-table/akros-variants:grid @max-akros-variant-table/akros-variants:h-auto! @max-akros-variant-table/akros-variants:min-w-0 @max-akros-variant-table/akros-variants:grid-cols-[minmax(0,1fr)_auto] @max-akros-variant-table/akros-variants:gap-(--dimension-8) @max-akros-variant-table/akros-variants:items-center @max-akros-variant-table/akros-variants:border-(length:--border-sm)! @max-akros-variant-table/akros-variants:border-(--akros-variant-table-border-color)! @max-akros-variant-table/akros-variants:rounded-(--akros-variant-table-row-radius)! @max-akros-variant-table/akros-variants:p-(--dimension-12) @max-akros-variant-table/akros-variants:bg-base! @max-akros-variant-table/akros-variants:[&>td]:block @max-akros-variant-table/akros-variants:[&>td]:w-auto! @max-akros-variant-table/akros-variants:[&>td]:min-w-0 @max-akros-variant-table/akros-variants:[&>td]:border-0! @max-akros-variant-table/akros-variants:[&>td]:rounded-none! @max-akros-variant-table/akros-variants:[&>td]:p-(--dimension-0)! @max-akros-variant-table/akros-variants:[&>td]:bg-(--color-bg-transparent)! @max-akros-variant-table/akros-variants:[&>td:is(:nth-child(1),:nth-child(2),:nth-child(6))]:col-span-full @max-akros-variant-table/akros-variants:[&>td:nth-child(3)]:hidden @max-akros-variant-table/akros-variants:[&>td:nth-child(4)]:col-start-2 @max-akros-variant-table/akros-variants:[&>td:nth-child(4)]:row-start-3 @max-akros-variant-table/akros-variants:[&>td:nth-child(5)]:col-start-1 @max-akros-variant-table/akros-variants:[&>td:nth-child(5)]:row-start-3 @max-akros-variant-table/akros-variants:[&>td:nth-child(6)]:border-t-(length:--border-sm)! @max-akros-variant-table/akros-variants:[&>td:nth-child(6)]:border-(--akros-variant-table-cell-separator-color)! @max-akros-variant-table/akros-variants:[&>td:nth-child(6)]:pt-(--dimension-12)! ${variantListRowClassName}`,
            },
          }}
          tableLayout="fixed"
          translations={{
            emptyDescription: "Upravte zadané filtry a zkuste to znovu.",
            emptyTitle: "Nenalezena žádná varianta",
          }}
          variant="line"
        />
      </>
    </div>
  );
}
