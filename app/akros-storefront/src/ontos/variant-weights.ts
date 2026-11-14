import variantWeights from "@/catalog-import/generated/variant-weights.generated.json";

const weights = variantWeights as Record<string, number>;
const weightUnits = new Set(["ks", "m"]);

/**
 * Kilograms per one sales unit (kg/ks or kg/m) of a SKU. OntOS merchandise carries no variant weight, so this
 * comes from the AKROS source feed index (`scripts/variant-weights.mjs`). Unknown SKU, another unit or a
 * missing/zero source weight stays `undefined`; it is never estimated or inherited from the parent product.
 */
export function sourceUnitWeightKg(sku: string, unit: string): number | undefined {
  if (!weightUnits.has(unit.trim().toLowerCase())) return undefined;
  const weight = weights[sku.trim().toLowerCase()];
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : undefined;
}
