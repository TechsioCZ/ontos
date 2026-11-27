"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { Table } from "@techsio/ui-kit/organisms/table";
import { ProductVariantLink } from "@/components/product-variant-link";
import { useProductVariants } from "@/features/cart/product-variants-context";

import { useCart } from "@/features/cart/cart-provider";
import { useDictionary, useFormatPrice, useMoney } from "@/ontos/market-context";
import type { Dictionary } from "@/i18n";
import { priceUnavailableText } from "@/lib/format";
import { getProductStockStatus, stockStatusLabel } from "@/lib/product-stock";
import { getVariantRangeFilters, type NumericRange } from "@/lib/product-variant-filters";
import { VariantRangeFilter } from "./variant-range-filter";
import {
  matchesProductVariantSearch,
  normalizeCatalogSearchTerm,
} from "@/lib/product-variant-search";
import { getMaximumOrderQuantity, normalizeOrderQuantity } from "@/features/cart/cart-state";
import type { CatalogPurchaseProduct, CatalogPurchaseVariant } from "@/ontos/catalog-types";
import {
  compareVariants,
  formatVariantLabel,
  VARIANT_PAGE_SIZE,
  type VariantTablePage,
} from "@/lib/product-variant-table";

interface ProductPurchaseFormProps {
  product: CatalogPurchaseProduct;
  variant?: CatalogPurchaseVariant;
  /** Every variant of the table, or only its first page when `variantPage` is set. */
  variants?: CatalogPurchaseVariant[];
  /** A long table: the server sent its first page; filters, pages and search read every variant on demand. */
  variantPage?: VariantTablePage;
  initialVariantSearch?: string;
}

const noVariants: CatalogPurchaseVariant[] = [];

const variantAvailabilityLabel = (cs: Dictionary, variant: CatalogPurchaseVariant): string =>
  stockStatusLabel(cs, getProductStockStatus(variant), variant.belowPackage, variant.unit);

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

function orderQuantityError(
  quantity: number,
  minimum: number,
  maximum: number,
  step: number,
  unit: string,
  cs: Dictionary,
  locale: string,
) {
  const format = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  if (!Number.isFinite(quantity)) return cs.product.quantityRequired;
  if (quantity < minimum) return cs.product.quantityMinimum(format(minimum), unit);
  if (quantity > maximum) return cs.product.quantityMaximum(format(maximum), unit);
  const lower = Number((Math.floor(quantity / step) * step).toFixed(6));
  const upper = Number((Math.ceil(quantity / step) * step).toFixed(6));
  return cs.product.quantityMultiple(format(step), unit, format(lower), format(upper));
}

interface VariantOrderControlProps {
  mode: "minimum" | "package";
  onAdd: (variant: CatalogPurchaseVariant, quantity: number) => void;
  product: CatalogPurchaseProduct;
  variant: CatalogPurchaseVariant;
}

/** Typed quantity in either decimal separator (Czech comma or dot); empty or malformed is NaN. */
const parseQuantity = (text: string) => {
  const value = text.replace(/[\s\u00a0\u202f]/gu, "").replace(",", ".");
  return /^\d*\.?\d+$|^\d+\.$/u.test(value) ? Number(value) : Number.NaN;
};

/**
 * One row's quantity editor and buy button. Native elements styled by the `sf-variant-table` classes
 * (globals.css applies the kit's numeric input and button utilities once): every row is server-rendered,
 * so the kit's per-element utility strings would make each row about six times larger.
 */
function VariantOrderControl({ mode, onAdd, product, variant }: VariantOrderControlProps) {
  const cs = useDictionary();
  const money = useMoney();
  const id = useId();
  const isPackage = mode === "package";
  const packageQuantity = variant.packageQuantity ?? variant.minimumQuantity;
  const maximumOrderQuantity = getMaximumOrderQuantity(getVariantCartItem(product, variant));
  // Whole packages, counted without binary-fraction drift (1,5 m packages: 4,5 m is 3 packages).
  const packages = (quantity: number) => Number((quantity / packageQuantity).toFixed(6));
  const maximum = isPackage ? Math.floor(packages(maximumOrderQuantity)) : maximumOrderQuantity;
  const minimum = isPackage
    ? Math.max(1, Math.ceil(packages(variant.minimumQuantity)))
    : variant.minimumQuantity;
  const step = isPackage ? 1 : (variant.quantityStep ?? variant.minimumQuantity);
  const [draft, setDraft] = useState(String(minimum));
  const [showError, setShowError] = useState(false);
  const selectedQuantity = parseQuantity(draft);
  const quantityToAdd = isPackage
    ? Number((Math.max(selectedQuantity, 1) * packageQuantity).toFixed(6))
    : selectedQuantity;
  const label = formatVariantLabel(variant);
  const validQuantity =
    Number.isFinite(selectedQuantity) &&
    selectedQuantity >= minimum &&
    selectedQuantity <= maximum &&
    (!isPackage || Number.isInteger(selectedQuantity)) &&
    normalizeOrderQuantity(getVariantCartItem(product, variant), quantityToAdd) === quantityToAdd;
  const disabled =
    maximum <= 0 ||
    !validQuantity ||
    variant.priceMinor <= 0 ||
    !!variant.priceUnavailableReason ||
    !!variant.availabilityUnknown;
  const error =
    showError && !validQuantity
      ? isPackage
        ? cs.product.packageQuantityInvalid
        : orderQuantityError(
            selectedQuantity,
            minimum,
            maximum,
            step,
            variant.unit,
            cs,
            money.locale,
          )
      : undefined;
  const hint =
    !isPackage && step !== 1
      ? cs.product.orderIncrement(step.toLocaleString(money.locale), variant.unit)
      : undefined;
  const current = Number.isFinite(selectedQuantity) ? selectedQuantity : minimum;
  const stepBy = (direction: 1 | -1) => {
    const next = Number((current + direction * step).toFixed(6));
    setDraft(String(Math.min(Math.max(next, minimum), Math.max(maximum, minimum))));
    setShowError(false);
  };
  const canDecrement = maximum > 0 && current > minimum;
  const canIncrement = maximum > 0 && current < maximum;
  // A typed quantity outside what can be bought snaps back into range at once; an off-step one is flagged.
  const commitDraft = () => {
    if (Number.isFinite(selectedQuantity) && maximum >= minimum) {
      const clamped = Math.min(Math.max(selectedQuantity, minimum), maximum);
      if (clamped !== selectedQuantity) setDraft(String(clamped));
    }
    setShowError(true);
  };

  return (
    <div className={`sf-variant-table__order sf-variant-table__order--${mode}`} data-part="root">
      <div
        className="sf-variant-table__quantity-control"
        data-invalid={error ? "" : undefined}
        role="group"
      >
        <button
          aria-label={isPackage ? cs.product.decrementPackages : cs.product.decrementQuantity}
          disabled={!canDecrement}
          onClick={() => stepBy(-1)}
          tabIndex={-1}
          type="button"
        >
          <span aria-hidden="true" className="token-icon-minus" />
        </button>
        <input
          aria-describedby={hint ? `${id}-hint` : undefined}
          aria-errormessage={error ? `${id}-error` : undefined}
          aria-invalid={error ? true : undefined}
          aria-label={isPackage ? cs.product.packagesOf(label) : cs.product.quantityOf(label)}
          aria-roledescription="numberfield"
          aria-valuemax={Math.max(maximum, minimum)}
          aria-valuemin={minimum}
          aria-valuenow={Number.isFinite(selectedQuantity) ? selectedQuantity : undefined}
          autoComplete="off"
          data-invalid={error ? "" : undefined}
          disabled={maximum <= 0}
          id={id}
          inputMode="decimal"
          onBlur={commitDraft}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setShowError(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitDraft();
            else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              stepBy(event.key === "ArrowUp" ? 1 : -1);
            }
          }}
          role="spinbutton"
          spellCheck={false}
          type="text"
          value={draft}
        />
        <button
          aria-label={isPackage ? cs.product.incrementPackages : cs.product.incrementQuantity}
          disabled={!canIncrement}
          onClick={() => stepBy(1)}
          tabIndex={-1}
          type="button"
        >
          <span aria-hidden="true" className="token-icon-plus" />
        </button>
      </div>
      <button
        aria-label={isPackage ? cs.product.buyPackageOf(label) : cs.product.buyItem(label)}
        className={
          isPackage
            ? "sf-variant-table__buy-button sf-variant-table__buy-button--package"
            : "sf-variant-table__buy-button"
        }
        disabled={disabled}
        onClick={() => onAdd(variant, quantityToAdd)}
        type="button"
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
      </button>
      {hint && (
        <div
          className="sf-variant-order__hint status-text-neutral-prefix"
          data-status="default"
          id={`${id}-hint`}
        >
          <span>{hint}</span>
        </div>
      )}
      {error && (
        <div
          className="sf-variant-order__error"
          data-status="error"
          id={`${id}-error`}
          role="alert"
        >
          <span aria-hidden="true" className="sf-variant-order__error-icon">
            <span className="token-icon-status-text-error" />
          </span>
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

/** First, last and the pages around the current one; a gap stands for the pages between. */
const pagerItems = (page: number, pageCount: number): (number | "gap")[] => {
  const pages = [...new Set([1, page - 1, page, page + 1, pageCount])]
    .filter((item) => item >= 1 && item <= pageCount)
    .sort((left, right) => left - right);
  return pages.flatMap((item, index) =>
    index > 0 && item - pages[index - 1] > 1 ? (["gap", item] as const) : [item],
  );
};

/** The variant table's pages: native buttons with the kit's pagination look applied once in globals.css. */
function VariantPager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  const cs = useDictionary();
  return (
    <nav aria-label={cs.variants.pagination} className="sf-pagination sf-variant-pager">
      <ul>
        <li>
          <button
            aria-label={cs.pagination.previous}
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
            type="button"
          >
            <span aria-hidden="true" className="token-icon-pagination-prev" />
          </button>
        </li>
        {pagerItems(page, pageCount).map((item, index) =>
          item === "gap" ? (
            <li data-gap="" key={`gap-${index}`}>
              <span aria-hidden="true">…</span>
            </li>
          ) : (
            <li key={item}>
              <button
                aria-current={item === page ? "page" : undefined}
                aria-label={cs.pagination.page(item, pageCount)}
                data-selected={item === page ? "" : undefined}
                onClick={() => onPage(item)}
                type="button"
              >
                {item}
              </button>
            </li>
          ),
        )}
        <li>
          <button
            aria-label={cs.pagination.next}
            disabled={page >= pageCount}
            onClick={() => onPage(page + 1)}
            type="button"
          >
            <span aria-hidden="true" className="token-icon-pagination-next" />
          </button>
        </li>
      </ul>
    </nav>
  );
}

export function ProductPurchaseForm({
  product,
  variant,
  variants,
  variantPage,
  initialVariantSearch,
}: ProductPurchaseFormProps) {
  const { addItem, adding } = useCart();
  const cs = useDictionary();
  const money = useMoney();
  const formatPrice = useFormatPrice();
  const { list, load } = useProductVariants();
  // A long table holds every variant only once the shopper filtered or paged (one read for the product page).
  const allVariants = variantPage
    ? list.status === "ready"
      ? list.variants
      : undefined
    : (variants ?? noVariants);
  // Only dimensions read reliably from the source labels/parameters become filters; they apply live.
  const filters = useMemo(
    () =>
      allVariants
        ? getVariantRangeFilters(product, allVariants)
        : (variantPage?.filters ?? []).map(({ stops, ...filter }) => ({
            ...filter,
            values: new Map(stops.map((stop, index) => [String(index), stop] as const)),
          })),
    [product, allVariants, variantPage],
  );
  const [ranges, setRanges] = useState<Record<string, NumericRange>>({});
  const [filterRevision, setFilterRevision] = useState(0);
  const [page, setPage] = useState(1);
  const [quantity, setQuantity] = useState(variant?.minimumQuantity ?? product.minimumQuantity);
  const [showQuantityError, setShowQuantityError] = useState(false);
  const normalizedSearchTerm = normalizeCatalogSearchTerm(initialVariantSearch ?? "");
  const visibleVariants = useMemo(
    () =>
      allVariants
        ?.filter(
          (item) =>
            (!normalizedSearchTerm || matchesProductVariantSearch(item, normalizedSearchTerm)) &&
            filters.every((filter) => {
              const range = ranges[filter.id];
              const value = filter.values.get(item.id);
              return !range || (value !== undefined && value >= range[0] && value <= range[1]);
            }),
        )
        .sort(compareVariants),
    [allVariants, normalizedSearchTerm, filters, ranges],
  );
  const addVariant = useCallback(
    (variant: CatalogPurchaseVariant, selectedQuantity: number) => {
      void addItem(getVariantCartItem(product, variant), selectedQuantity, variant.priceTiers);
    },
    [addItem, product],
  );
  const visibleCount = visibleVariants?.length ?? variantPage?.matching ?? 0;
  const totalCount = allVariants?.length ?? variantPage?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(visibleCount / VARIANT_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageOffset = (currentPage - 1) * VARIANT_PAGE_SIZE;
  // Until every variant is here the table keeps the server's first page (already searched and sorted).
  const shownVariants = visibleVariants
    ? visibleVariants.slice(pageOffset, pageOffset + VARIANT_PAGE_SIZE)
    : (variants ?? noVariants);
  const waitingForAll =
    variantPage !== undefined &&
    allVariants === undefined &&
    (Object.keys(ranges).length > 0 || page > 1);
  useEffect(() => {
    // A failed read is offered again by its retry button, never in a loop.
    if (waitingForAll && list.status === "idle") load();
  }, [waitingForAll, list.status, load]);

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
    const validQuantity =
      Number.isFinite(quantity) && normalizeOrderQuantity(productCartItem, quantity) === quantity;
    const step = purchaseItem.quantityStep ?? purchaseItem.minimumQuantity;
    const error =
      showQuantityError && !validQuantity
        ? orderQuantityError(
            quantity,
            purchaseItem.minimumQuantity,
            maximumQuantity,
            step,
            purchaseItem.unit,
            cs,
            money.locale,
          )
        : undefined;

    return (
      <div className="sf-purchase-form">
        <NumericInput
          className="col-span-full grid! grid-cols-subgrid gap-(--dimension-8)!"
          id={`quantity-${product.id}`}
          locale={money.locale}
          // Nothing to buy (stock below one first order): the quantity cannot be edited either.
          disabled={maximumQuantity <= 0}
          min={purchaseItem.minimumQuantity}
          max={Math.max(maximumQuantity, purchaseItem.minimumQuantity)}
          step={step}
          onChange={(value) => {
            setQuantity(value);
            setShowQuantityError(false);
          }}
          // A typed quantity out of range is clamped on blur; an off-step one is flagged then.
          onValueCommit={() => setShowQuantityError(true)}
          invalid={!!error}
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
          <Button
            block
            className="max-lg:order-last"
            disabled={
              adding ||
              maximumQuantity <= 0 ||
              !validQuantity ||
              purchaseItem.priceMinor <= 0 ||
              !!purchaseItem.priceUnavailableReason ||
              !!purchaseItem.availabilityUnknown
            }
            title={
              purchaseItem.priceUnavailableReason
                ? cs.product.priceUnavailableTitle(
                    priceUnavailableText(purchaseItem.priceUnavailableReason, cs, money),
                  )
                : purchaseItem.availabilityUnknown
                  ? stockStatusLabel(cs, "unknown")
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
          {step !== 1 && (
            <NumericInput.StatusText
              className="col-start-1 justify-center text-center"
              size="sm"
              align="center"
            >
              {cs.product.orderIncrement(step.toLocaleString(money.locale), purchaseItem.unit)}
            </NumericInput.StatusText>
          )}
          {error && (
            <NumericInput.StatusText className="col-span-full text-start" size="sm" status="error">
              {error}
            </NumericInput.StatusText>
          )}
        </NumericInput>
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
                onChange={(value) => {
                  const previous = ranges[filter.id] ?? filter.bounds;
                  if (previous[0] === value[0] && previous[1] === value[1]) return;
                  setRanges((current) => ({ ...current, [filter.id]: value }));
                  setPage(1);
                }}
              />
            ))}
            <Button
              type="button"
              size="sm"
              theme="outlined"
              variant="secondary"
              onClick={() => {
                setRanges({});
                setPage(1);
                setFilterRevision((revision) => revision + 1);
              }}
            >
              {cs.variants.resetFilters}
            </Button>
          </form>
        </section>
      )}
      <output className="block m-0 text-sm text-fg-secondary">
        {cs.variants.shown(visibleCount, totalCount)}
      </output>
      {waitingForAll && list.status === "failed" ? (
        <p className="sf-variant-purchase__status" role="alert">
          {cs.variants.loadFailed}{" "}
          <Button type="button" size="sm" theme="outlined" variant="secondary" onClick={load}>
            {cs.variants.retry}
          </Button>
        </p>
      ) : (
        waitingForAll && (
          <output className="sf-variant-purchase__status">{cs.variants.loading}</output>
        )
      )}

      <>
        <div
          aria-busy={waitingForAll || undefined}
          className="sf-variant-data-table flex w-full flex-col overflow-hidden rounded-data-table border-(length:--border-width-data-table) border-data-table-border"
        >
          <div className="relative w-full overflow-auto">
            <Table
              aria-label={cs.product.variantsTitle}
              aria-rowcount={visibleCount + 1}
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
                      width: "8%",
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
                      width: "11%",
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
                {shownVariants.map((item, index) => {
                  const label = formatVariantLabel(item);
                  const isAvailable = getProductStockStatus(item) === "in-stock";
                  const basePriceTier = item.priceTiers[0];
                  // A package of several units is bought only whole, so it gets the one control.
                  const sellsInPackages =
                    item.packageQuantity !== undefined && item.packageQuantity > 1;
                  // Native cells styled once in globals.css: these rows are rendered on the server.
                  return (
                    <tr
                      key={item.id}
                      aria-rowindex={pageOffset + index + 2}
                      className="sf-variant-data-table__row"
                    >
                      <td>
                        <div className="sf-variant-table__name">
                          <strong className="sf-variant-table__label">
                            <ProductVariantLink
                              slug={product.slug}
                              imageSrc={product.imageSrc}
                              variant={item}
                              label={label}
                            />
                          </strong>
                          <p className="sf-variant-table__list-only sf-variant-table__list-sku">
                            {cs.product.code}: {item.sku}
                          </p>
                        </div>
                      </td>
                      <td>
                        <span className="sf-variant-table__sku">
                          <span className="sf-variant-table__mobile-label">
                            {cs.product.code}:{" "}
                          </span>
                          <span>{item.sku}</span>
                        </span>
                      </td>
                      <td data-align="center">{item.unit}</td>
                      <td>
                        <strong
                          className="sf-variant-table__availability sf-variant-table__stock"
                          data-available={isAvailable}
                          title={
                            item.availabilityUnknown
                              ? cs.product.variantAvailabilityUnknown
                              : undefined
                          }
                        >
                          {variantAvailabilityLabel(cs, item)}
                        </strong>
                      </td>
                      <td>
                        <div className="sf-variant-table__price">
                          <div className="sf-variant-table__list-only sf-variant-table__list-stock">
                            <span
                              className="sf-variant-table__availability"
                              data-available={isAvailable}
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
                                {priceUnavailableText(item.priceUnavailableReason, cs, money)}
                              </small>
                            </span>
                          ) : (
                            <>
                              {item.originalPriceMinor !== undefined &&
                                item.originalPriceMinor > item.priceMinor && (
                                  <s className="text-xs text-fg-secondary">
                                    {formatPrice(item.originalPriceMinor)}
                                  </s>
                                )}
                              <strong className="sf-variant-table__amount">
                                {formatPrice(item.priceMinor).replace(/\s(?=\S+$)/u, " ")}
                                <span className="sf-variant-table__mobile-label sf-variant-table__unit">
                                  {" "}
                                  / {item.unit}
                                </span>
                              </strong>
                              {basePriceTier && (
                                <small className="sf-variant-table__net">
                                  {formatPrice(basePriceTier.priceExcludingVatMinor)}{" "}
                                  {cs.product.excludingVat}
                                </small>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                      <td data-align="center">
                        <div className="sf-variant-table__purchase-cell sf-variant-table__purchase-cell--row">
                          {sellsInPackages ? (
                            <>
                              <span aria-hidden="true" className="sf-variant-table__no-package">
                                —
                              </span>
                              <VariantOrderControl
                                mode="package"
                                onAdd={addVariant}
                                product={product}
                                variant={item}
                              />
                            </>
                          ) : (
                            <>
                              <VariantOrderControl
                                mode="minimum"
                                onAdd={addVariant}
                                product={product}
                                variant={item}
                              />
                              <span aria-hidden="true" className="sf-variant-table__no-package">
                                —
                              </span>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visibleCount === 0 && (
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
        {pageCount > 1 && (
          <VariantPager
            page={currentPage}
            pageCount={pageCount}
            onPage={(next) => {
              setPage(next);
              const section = document.getElementById("product-variants");
              if (section && section.getBoundingClientRect().top < 0)
                section.scrollIntoView({ block: "start" });
            }}
          />
        )}
      </>
    </div>
  );
}
