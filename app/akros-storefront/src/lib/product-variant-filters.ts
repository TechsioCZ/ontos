import type { CatalogProduct, CatalogPurchaseVariant } from "@/ontos/catalog-types";

export type NumericRange = [number, number];
export interface VariantRangeFilter {
  id: string;
  label: string;
  bounds: NumericRange;
  step: number;
  values: ReadonlyMap<string, number>;
}

const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
const numberFromText = (text: string) =>
  /^\d+(?:[.,]\d+)?$/.test(text.trim()) ? Number(text.trim().replace(",", ".")) : null;
const parameterLabels = new Set([
  "prumer",
  "vnitrni prumer",
  "vnejsi prumer",
  "delka",
  "sirka",
  "vyska",
  "tloustka",
  "sila materialu",
]);

function makeFilter(
  id: string,
  label: string,
  variants: CatalogPurchaseVariant[],
  values: (number | null)[],
): VariantRangeFilter | null {
  if (values.some((value) => value === null || !Number.isFinite(value) || value <= 0)) return null;
  const numbers = values.filter((value): value is number => value !== null);
  const minimum = Math.min(...numbers);
  const maximum = Math.max(...numbers);
  if (minimum >= maximum) return null;
  const precision = Math.max(...numbers.map((value) => (String(value).split(".")[1] ?? "").length));
  return {
    id,
    label,
    bounds: [minimum, maximum],
    step: 10 ** -precision,
    values: new Map(variants.map((variant, index) => [variant.id, numbers[index]])),
  };
}

/** Label dimensions are interpreted only for these known catalog families. */
export function getVariantRangeFilters(
  product: Pick<CatalogProduct, "name">,
  variants: CatalogPurchaseVariant[],
): VariantRangeFilter[] {
  if (variants.length < 2) return [];
  const name = normalize(product.name);
  let dimensions: { id: string; label: string; aliases: string[] }[] = [];
  if (/^(srouby|vruty|nyty|cepy|zavitove tyce)\b/.test(name)) {
    dimensions = [
      { id: "diameter", label: "Průměr", aliases: ["prumer", "dimension_a"] },
      { id: "length", label: "Délka", aliases: ["delka", "dimension_b"] },
    ];
  } else if (/^plechy\b/.test(name)) {
    dimensions = [
      { id: "thickness", label: "Tloušťka", aliases: ["tloustka", "sila materialu"] },
      { id: "width", label: "Šířka", aliases: ["sirka"] },
      { id: "length", label: "Délka", aliases: ["delka"] },
    ];
  } else if (/^trubky\b/.test(name)) {
    dimensions = /ctvercov|obdelnikov/.test(name)
      ? [
          { id: "width", label: "Šířka", aliases: ["sirka"] },
          { id: "height", label: "Výška", aliases: ["vyska"] },
          { id: "thickness", label: "Tloušťka stěny", aliases: ["tloustka", "sila materialu"] },
        ]
      : [
          { id: "diameter", label: "Vnější průměr", aliases: ["vnejsi prumer"] },
          { id: "thickness", label: "Tloušťka stěny", aliases: ["tloustka", "sila materialu"] },
        ];
  }
  const parsed = variants.map((variant) => {
    const match = variant.label.match(/\d+(?:[.,]\d+)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)+/i);
    return match ? match[0].split(/\s*[x×]\s*/i).map(numberFromText) : [];
  });
  if (dimensions.length && parsed.every((values) => values.length === dimensions.length)) {
    return dimensions.flatMap((dimension, index) => {
      const values = variants.map((variant, variantIndex) => {
        const parsedValue = parsed[variantIndex][index];
        const explicit = variant.parameters.find((parameter) =>
          dimension.aliases.includes(normalize(parameter.label)),
        );
        // Conflicting or differently scaled feed data must not silently become a filter.
        if (
          explicit &&
          (numberFromText(explicit.value) !== parsedValue ||
            (explicit.unit && normalize(explicit.unit) !== "mm"))
        )
          return null;
        return parsedValue;
      });
      const filter = makeFilter(dimension.id, `${dimension.label} (mm)`, variants, values);
      return filter ? [filter] : [];
    });
  }
  // Outside known families, use only explicit, fully populated, human-readable dimensions.
  return variants[0].parameters.flatMap((parameter) => {
    const key = normalize(parameter.label);
    if (!parameterLabels.has(key)) return [];
    const values = variants.map((variant) => {
      const source = variant.parameters.find(
        (item) => normalize(item.label) === key && item.unit === parameter.unit,
      );
      return source ? numberFromText(source.value) : null;
    });
    const filter = makeFilter(
      `parameter-${key}`,
      `${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ""}`,
      variants,
      values,
    );
    return filter ? [filter] : [];
  });
}
