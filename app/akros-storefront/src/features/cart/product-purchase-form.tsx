"use client";

import { useCallback, useId, useMemo, useState } from "react";
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

const variantsPerPage = 5;
const noVariants: CatalogProductVariant[] = [];
const variantCollator = new Intl.Collator("cs-CZ", {
  numeric: true,
  sensitivity: "base",
});
const measurementFormatter = new Intl.NumberFormat("cs-CZ", {
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

const formatMeasurementRange = (values: number[]) =>
  values.map((value) => measurementFormatter.format(value)).join(" – ");

const formatPriceRange = (values: number[]) =>
  values.map((value) => formatPrice(value)).join(" – ");

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
    <div className={`akros-variant-table__order akros-variant-table__order--${mode}`}>
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
        <NumericInput.Control className="akros-variant-table__quantity-control">
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
        className="akros-variant-table__buy-button"
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
        meta: { width: "16%" },
        cell: ({ row }) => {
          const label = formatVariantLabel(row.original);

          return (
            <div className="akros-variant-table__name">
              <span>{product.name}</span>
              <strong>{label}</strong>
            </div>
          );
        },
      },
      {
        accessorKey: "sku",
        header: "Kód",
        meta: { width: "12%" },
        cell: ({ row }) => (
          <span className="akros-variant-table__sku">
            <span className="akros-variant-table__mobile-label">Kód: </span>
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
            <strong className="akros-variant-table__availability" data-available={isAvailable}>
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
            <div className="akros-variant-table__price">
              <strong>
                {formatPrice(row.original.priceMinor)}
                <span className="akros-variant-table__mobile-label"> / {row.original.unit}</span>
              </strong>
              {basePriceTier && (
                <small>{formatPrice(basePriceTier.priceExcludingVatMinor)} bez DPH</small>
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
          const hasSeparatePackage = packageQuantity > item.minimumQuantity;

          return (
            <div className="akros-variant-table__purchase-cell">
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
                <span aria-hidden="true" className="akros-variant-table__no-package">
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

  const applyFilters = () => {
    setAppliedMaterials(selectedMaterials);
    setAppliedDiameterRange(diameterRange);
    setAppliedLengthRange(lengthRange);
    setAppliedPriceRange(priceRange);
    setPage(1);
  };

  return (
    <div className="akros-variant-purchase">
      <section className="akros-variant-purchase__controls">
        <form
          aria-label="Filtrování variant"
          className="akros-variant-purchase__filter-bar"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
        >
          {dimensionBounds && dimensionBounds.diameter[0] < dimensionBounds.diameter[1] && (
            <Slider
              className="akros-variant-purchase__filter-group akros-variant-purchase__filter-group--slider"
              formatRangeText={formatMeasurementRange}
              formatValue={(value) => measurementFormatter.format(value)}
              label="Průměr (mm)"
              max={dimensionBounds.diameter[1]}
              min={dimensionBounds.diameter[0]}
              onChange={(values) => setDiameterRange(values as NumericRange)}
              showValueText
              size="sm"
              step={dimensionBounds.diameterStep}
              value={diameterRange}
            />
          )}

          {dimensionBounds && dimensionBounds.length[0] < dimensionBounds.length[1] && (
            <Slider
              className="akros-variant-purchase__filter-group akros-variant-purchase__filter-group--slider"
              formatRangeText={formatMeasurementRange}
              formatValue={(value) => measurementFormatter.format(value)}
              label="Délka (mm)"
              max={dimensionBounds.length[1]}
              min={dimensionBounds.length[0]}
              onChange={(values) => setLengthRange(values as NumericRange)}
              showValueText
              size="sm"
              step={dimensionBounds.lengthStep}
              value={lengthRange}
            />
          )}

          {materialOptions.length > 0 && (
            <fieldset className="akros-variant-purchase__filter-group akros-variant-purchase__filter-group--material">
              <legend>Materiál</legend>
              <div className="akros-variant-purchase__material-options">
                {materialOptions.map((material) => (
                  <FormCheckbox
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

          {priceBounds && priceBounds[0] < priceBounds[1] && (
            <Slider
              className="akros-variant-purchase__filter-group akros-variant-purchase__filter-group--slider akros-variant-purchase__filter-group--price"
              formatRangeText={formatPriceRange}
              formatValue={(value) => formatPrice(value)}
              label={`Cena (Kč/${product.unit})`}
              max={priceBounds[1]}
              min={priceBounds[0]}
              onChange={(values) => setPriceRange(values as NumericRange)}
              showValueText
              size="sm"
              step={1}
              value={priceRange}
            />
          )}

          <Button size="sm" type="submit" uppercase variant="primary">
            Filtrovat
          </Button>
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
              className: "akros-variant-data-table__table",
            },
            row: { className: "akros-variant-data-table__row" },
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
