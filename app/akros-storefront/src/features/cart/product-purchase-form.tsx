"use client";

import { useCallback, useId, useMemo, useState, type CSSProperties } from "react";
import { Button } from "@techsio/ui-kit/atoms/button";
import { NumericInput } from "@techsio/ui-kit/atoms/numeric-input";
import { FormCheckbox } from "@techsio/ui-kit/molecules/form-checkbox";
import { Pagination } from "@techsio/ui-kit/molecules/pagination";
import { Slider } from "@techsio/ui-kit/molecules/slider";
import { DataTable, type ColumnDef } from "@techsio/ui-kit/organisms/data-table";

import { useCart } from "@/features/cart/cart-provider";
import { cs } from "@/i18n/cs";
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

const variantsPerPage = 5;
const variantListOnlyClassName =
  "hidden @min-akros-variant-list/akros-variants:@max-akros-variant-table/akros-variants:block";
const noVariants: CatalogProductVariant[] = [];
const variantCollator = new Intl.Collator("cs-CZ", {
  numeric: true,
  sensitivity: "base",
});
const measurementFormatter = new Intl.NumberFormat("cs-CZ", {
  maximumFractionDigits: 2,
});
const priceInputFormatter = new Intl.NumberFormat("cs-CZ", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

type NumericRange = [number, number];

interface VariantDimensions {
  diameter: number;
  length: number;
}

const parseVariantDimensions = (label: string): VariantDimensions | null => {
  const match = label.match(/(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/i);
  if (!match?.[1] || !match[2]) return null;

  const diameter = Number(match[1].replace(",", "."));
  const length = Number(match[2].replace(",", "."));

  return Number.isFinite(diameter) && Number.isFinite(length) ? { diameter, length } : null;
};

const getRange = (values: number[]): NumericRange | null => {
  if (values.length === 0) return null;

  return [Math.min(...values), Math.max(...values)];
};

const isWithinRange = (value: number, [minimum, maximum]: NumericRange) =>
  value >= minimum && value <= maximum;

const filterGroupClassName =
  "min-w-0 border-base-dark border-b-(length:--border-sm) py-(--dimension-12) md:border-b-0 md:border-r-(length:--border-sm) md:px-(--dimension-12) md:py-0";

interface VariantRangeFilterProps {
  bounds: NumericRange;
  label: string;
  onChange: (value: NumericRange) => void;
  price?: boolean;
  step: number;
  value: NumericRange;
}

function VariantRangeFilter({
  bounds,
  label,
  onChange,
  price = false,
  step,
  value,
}: VariantRangeFilterProps) {
  const scale = price ? 100 : 1;
  const priceInputStyle: CSSProperties & {
    "--akros-variant-filter-price-characters"?: number;
  } = price
    ? {
        "--akros-variant-filter-price-characters": Math.max(
          ...bounds.map((bound) => priceInputFormatter.format(bound / scale).length),
        ),
      }
    : {};
  // Keep the NumericInput editing buffer (empty text and decimal separators).
  // Slider changes replace that buffer with the newly selected range.
  const [sliderRevision, setSliderRevision] = useState(0);
  const updateEndpoint = (index: 0 | 1, nextValue: number) => {
    if (!Number.isFinite(nextValue)) return;
    const next = price ? Math.round(nextValue * scale) : nextValue;
    if (next < bounds[0] || next > bounds[1]) return;
    if (index === 0 && next > value[1]) return;
    if (index === 1 && next < value[0]) return;
    onChange(index === 0 ? [next, value[1]] : [value[0], next]);
  };

  return (
    <div
      style={priceInputStyle}
      className={`akros-variant-filter-range ${filterGroupClassName} w-full md:shrink-0 md:@max-akros-variant-table/akros-variants:grow ${price ? "akros-variant-filter-range--price md:w-(--akros-variant-filter-price-width)" : "md:w-(--akros-variant-filter-measurement-width)"}`}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-(--dimension-8)">
        <NumericInput
          key={`minimum-${sliderRevision}`}
          className="w-(--akros-variant-filter-input-width)"
          locale="cs-CZ"
          min={bounds[0] / scale}
          max={value[1] / scale}
          precision={2}
          step={step / scale}
          defaultValue={value[0] / scale}
          onChange={(next) => updateEndpoint(0, next)}
          size="sm"
        >
          <NumericInput.Control>
            <NumericInput.Input aria-label={`Minimum – ${label}`} />
          </NumericInput.Control>
        </NumericInput>
        <Slider
          className="[&>div:first-child]:justify-center [&_label]:whitespace-nowrap [&_label]:text-(length:--akros-variant-filter-label-font-size) [&_label]:leading-(--akros-variant-filter-label-line-height) [&_[data-part=control]]:min-h-(--height-form-control-sm)"
          formatValue={price ? formatPrice : (next) => measurementFormatter.format(next)}
          label={label}
          max={bounds[1]}
          min={bounds[0]}
          minStepsBetweenThumbs={0}
          onChange={(next) => {
            if (next[0] !== undefined && next[1] !== undefined) {
              onChange([next[0], next[1]]);
              setSliderRevision((revision) => revision + 1);
            }
          }}
          size="sm"
          step={step}
          value={value}
        />
        <NumericInput
          key={`maximum-${sliderRevision}`}
          className="w-(--akros-variant-filter-input-width)"
          locale="cs-CZ"
          min={value[0] / scale}
          max={bounds[1] / scale}
          precision={2}
          step={step / scale}
          defaultValue={value[1] / scale}
          onChange={(next) => updateEndpoint(1, next)}
          size="sm"
        >
          <NumericInput.Control>
            <NumericInput.Input aria-label={`Maximum – ${label}`} />
          </NumericInput.Control>
        </NumericInput>
      </div>
    </div>
  );
}

const materialPattern =
  /\b(?:A[124](?:\s*-\s*\d+)?|AL(?:\/AL)?|1\.\d{4}|chrom|nerez|ocel|pozink|zinek)\b/i;

const normalizeMaterial = (material: string) => {
  const normalized = material.trim().replace(/\s+/g, " ");
  const commonMaterial = normalized.toLocaleLowerCase("cs-CZ");

  if (["chrom", "nerez", "ocel", "pozink", "zinek"].includes(commonMaterial)) {
    return commonMaterial.charAt(0).toLocaleUpperCase("cs-CZ") + commonMaterial.slice(1);
  }

  return normalized.toLocaleUpperCase("cs-CZ");
};

const getVariantMaterial = (product: CatalogProduct, variant: CatalogProductVariant) => {
  const materialParameter = variant.parameters.find((parameter) =>
    parameter.label.toLocaleLowerCase("cs-CZ").includes("material"),
  );
  if (materialParameter?.value.trim()) return normalizeMaterial(materialParameter.value);

  const variantMaterial = variant.label.match(materialPattern)?.[0];
  if (variantMaterial) return normalizeMaterial(variantMaterial);

  const productMaterial = product.name.match(materialPattern)?.[0];
  return productMaterial ? normalizeMaterial(productMaterial) : null;
};

const formatVariantLabel = (variant: CatalogProductVariant) => {
  const dimension = variant.label.match(/\bM\s*(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)/i);
  if (!dimension) return variant.label;

  return `M ${dimension[1]} × ${dimension[2]}`;
};

const getVariantCartItem = (product: CatalogProduct, variant: CatalogProductVariant) => ({
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
        block
        className="akros-variant-table__buy-button @max-akros-variant-table/akros-variants:min-h-(--dimension-44) @max-akros-variant-table/akros-variants:whitespace-normal! @max-akros-variant-table/akros-variants:[&>span]:flex-col! @max-akros-variant-table/akros-variants:[&>span]:items-center! @max-akros-variant-table/akros-variants:[&>span]:leading-(--akros-variant-table-compact-button-line-height)! @max-akros-variant-table/akros-variants:[&_small]:text-xs!"
        disabled={disabled}
        onClick={() => onAdd(variant, quantityToAdd)}
        size="sm"
        uppercase
        variant={isPackage ? "secondary" : "primary"}
      >
        {isPackage ? (
          <span>
            Koupit celé balení
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
  const variantDimensions = useMemo(
    () => new Map(sourceVariants.map((item) => [item.id, parseVariantDimensions(item.label)])),
    [sourceVariants],
  );
  const dimensionBounds = useMemo(() => {
    const dimensions = [...variantDimensions.values()];
    if (dimensions.length < 2 || dimensions.some((item) => item === null)) return null;

    const parsedDimensions = dimensions.filter((item): item is VariantDimensions => item !== null);
    const diameter = getRange(parsedDimensions.map((item) => item.diameter));
    const length = getRange(parsedDimensions.map((item) => item.length));

    return diameter && length
      ? {
          diameter,
          diameterStep: parsedDimensions.every((item) => Number.isInteger(item.diameter)) ? 1 : 0.1,
          length,
          lengthStep: parsedDimensions.every((item) => Number.isInteger(item.length)) ? 1 : 0.1,
        }
      : null;
  }, [variantDimensions]);
  const priceBounds = useMemo(
    () => getRange(sourceVariants.map((item) => item.priceMinor)),
    [sourceVariants],
  );
  const variantMaterials = useMemo(
    () => new Map(sourceVariants.map((item) => [item.id, getVariantMaterial(product, item)])),
    [product, sourceVariants],
  );
  const materialOptions = useMemo(() => {
    const materials = [...variantMaterials.values()];
    if (materials.length === 0 || materials.some((material) => material === null)) return [];

    return [...new Set(materials.filter((material): material is string => material !== null))].sort(
      (left, right) => variantCollator.compare(left, right),
    );
  }, [variantMaterials]);
  const initialDiameterRange: NumericRange = dimensionBounds?.diameter ?? [0, 0];
  const initialLengthRange: NumericRange = dimensionBounds?.length ?? [0, 0];
  const initialPriceRange: NumericRange = priceBounds ?? [0, 0];
  const [quantity, setQuantity] = useState(variant?.minimumQuantity ?? product.minimumQuantity);
  const [page, setPage] = useState(1);
  const [selectedMaterials, setSelectedMaterials] = useState(materialOptions);
  const [appliedMaterials, setAppliedMaterials] = useState(materialOptions);
  const [diameterRange, setDiameterRange] = useState<NumericRange>(initialDiameterRange);
  const [appliedDiameterRange, setAppliedDiameterRange] =
    useState<NumericRange>(initialDiameterRange);
  const [lengthRange, setLengthRange] = useState<NumericRange>(initialLengthRange);
  const [appliedLengthRange, setAppliedLengthRange] = useState<NumericRange>(initialLengthRange);
  const [priceRange, setPriceRange] = useState<NumericRange>(initialPriceRange);
  const [appliedPriceRange, setAppliedPriceRange] = useState<NumericRange>(initialPriceRange);
  const normalizedSearchTerm = normalizeCatalogSearchTerm(initialVariantSearch ?? "");
  const visibleVariants = useMemo(
    () =>
      sourceVariants
        .filter((item) => {
          const matchesSearch = normalizedSearchTerm
            ? matchesProductVariantSearch(item, normalizedSearchTerm)
            : true;
          const dimensions = variantDimensions.get(item.id);
          const matchesDiameter =
            !dimensionBounds ||
            (dimensions != null && isWithinRange(dimensions.diameter, appliedDiameterRange));
          const matchesLength =
            !dimensionBounds ||
            (dimensions != null && isWithinRange(dimensions.length, appliedLengthRange));
          const matchesPrice = !priceBounds || isWithinRange(item.priceMinor, appliedPriceRange);
          const material = variantMaterials.get(item.id);
          const matchesMaterial =
            materialOptions.length === 0 ||
            (material !== null && material !== undefined && appliedMaterials.includes(material));

          return (
            matchesSearch && matchesDiameter && matchesLength && matchesPrice && matchesMaterial
          );
        })
        .sort((left, right) =>
          variantCollator.compare(formatVariantLabel(left), formatVariantLabel(right)),
        ),
    [
      appliedDiameterRange,
      appliedLengthRange,
      appliedMaterials,
      appliedPriceRange,
      dimensionBounds,
      materialOptions.length,
      normalizedSearchTerm,
      priceBounds,
      sourceVariants,
      variantDimensions,
      variantMaterials,
    ],
  );
  const paginatedVariants = visibleVariants.slice(
    (page - 1) * variantsPerPage,
    page * variantsPerPage,
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
        meta: { width: "12%" },
        cell: ({ row }) => {
          const label = formatVariantLabel(row.original);

          return (
            <div className="akros-variant-table__name min-w-0">
              <span className="@max-akros-variant-table/akros-variants:hidden">{product.name}</span>
              <strong className="min-w-0 whitespace-normal wrap-anywhere @max-akros-variant-table/akros-variants:text-(length:--text-base)!">
                {label}
              </strong>
              <p
                className={`${variantListOnlyClassName} mt-(--dimension-8) text-xs font-normal text-fg-secondary`}
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
          <span className="akros-variant-table__sku block whitespace-normal break-all @max-akros-variant-table/akros-variants:text-xs @max-akros-variant-table/akros-variants:font-normal @max-akros-variant-table/akros-variants:text-fg-secondary">
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
        meta: { align: "center", width: "47%" },
        cell: ({ row }) => {
          const item = row.original;
          const packageQuantity = item.packageQuantity ?? item.minimumQuantity;
          const hasSeparatePackage = packageQuantity > item.minimumQuantity || !!item.quantityStep;

          return (
            <div className="akros-variant-table__purchase-cell @max-akros-variant-table/akros-variants:grid-cols-1! @max-akros-variant-table/akros-variants:gap-(--dimension-8)">
              {item.quantityStep && (
                <small className="col-span-full text-fg-secondary">
                  Pouze celá balení po {packageQuantity.toLocaleString("cs-CZ")} {item.unit}.{" "}
                  Minimální odběr {item.minimumQuantity.toLocaleString("cs-CZ")} {item.unit}.
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
    };
    const maximumQuantity = getMaximumOrderQuantity(productCartItem);

    return (
      <div className="akros-purchase-form">
        {purchaseItem.quantityStep && (
          <small className="col-span-full text-fg-secondary">
            Pouze celá balení po{" "}
            {(purchaseItem.packageQuantity ?? purchaseItem.quantityStep).toLocaleString("cs-CZ")}{" "}
            {purchaseItem.unit}.
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

  const applyFilters = () => {
    setAppliedMaterials(selectedMaterials);
    setAppliedDiameterRange(diameterRange);
    setAppliedLengthRange(lengthRange);
    setAppliedPriceRange(priceRange);
    setPage(1);
  };

  return (
    <div className="akros-variant-purchase @container/akros-variants">
      <section className="w-full max-w-full rounded-sm border-(length:--border-sm) border-base-dark bg-base p-(--akros-variant-filter-padding) md:w-fit md:@max-akros-variant-table/akros-variants:w-full">
        <form
          aria-label="Filtrování variant"
          className="akros-variant-purchase__filter-bar flex flex-col gap-y-(--dimension-12) md:flex-row md:flex-wrap md:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
        >
          {dimensionBounds && dimensionBounds.diameter[0] < dimensionBounds.diameter[1] && (
            <VariantRangeFilter
              bounds={dimensionBounds.diameter}
              label="Průměr (mm)"
              onChange={setDiameterRange}
              step={dimensionBounds.diameterStep}
              value={diameterRange}
            />
          )}

          {dimensionBounds && dimensionBounds.length[0] < dimensionBounds.length[1] && (
            <VariantRangeFilter
              bounds={dimensionBounds.length}
              label="Délka (mm)"
              onChange={setLengthRange}
              step={dimensionBounds.lengthStep}
              value={lengthRange}
            />
          )}

          {materialOptions.length > 0 && (
            <fieldset className={`${filterGroupClassName} m-0 min-w-0`}>
              <legend className="mx-auto mb-(--dimension-6) text-(length:--akros-variant-filter-label-font-size) leading-(--akros-variant-filter-label-line-height) font-medium">
                Materiál
              </legend>
              <div
                className={`grid gap-x-(--dimension-12) gap-y-(--dimension-4) ${materialOptions.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
              >
                {materialOptions.map((material) => (
                  <FormCheckbox
                    className="[&_[data-part=indicator][data-state=checked]]:token-icon-akros-checkbox-selected"
                    checked={selectedMaterials.includes(material)}
                    key={material}
                    label={material}
                    onCheckedChange={(checked) =>
                      setSelectedMaterials((current) =>
                        checked
                          ? [...current, material]
                          : current.filter((item) => item !== material),
                      )
                    }
                    size="sm"
                  />
                ))}
              </div>
            </fieldset>
          )}

          <div className="flex min-w-0 flex-col gap-y-(--dimension-12) md:flex-row md:items-center md:gap-x-(--dimension-12) md:@max-akros-variant-table/akros-variants:grow">
            {priceBounds && priceBounds[0] < priceBounds[1] && (
              <VariantRangeFilter
                bounds={priceBounds}
                label={`Cena (Kč/${product.unit})`}
                onChange={setPriceRange}
                price
                step={1}
                value={priceRange}
              />
            )}

            <Button
              className="akros-variant-filter-submit w-full md:ml-auto md:w-(--akros-variant-filter-submit-width)"
              size="sm"
              type="submit"
              uppercase
              variant="primary"
            >
              Filtruj
            </Button>
          </div>
        </form>
      </section>

      <>
        <DataTable
          className="akros-variant-data-table"
          columns={variantColumns}
          data={paginatedVariants}
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
        {visibleVariants.length > variantsPerPage && (
          <Pagination
            aria-label="Stránkování variant"
            className="akros-pagination"
            count={visibleVariants.length}
            getPageUrl={() => "#product-variants"}
            onChange={setPage}
            page={page}
            pageSize={variantsPerPage}
            showPrevNext
            size="md"
            variant="filled"
          />
        )}
      </>
    </div>
  );
}
