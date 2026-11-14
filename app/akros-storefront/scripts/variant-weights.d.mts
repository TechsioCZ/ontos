interface WeightSource {
  sku?: string;
  unit?: string;
  netWeight?: number;
  sourceNetWeight?: number;
}

/** SKU (trimmed, lower case) → kg per sales unit; see variant-weights.mjs. */
export function buildVariantWeights(
  products: readonly (WeightSource & { detail?: { variants?: readonly WeightSource[] } })[],
): Record<string, number>;
