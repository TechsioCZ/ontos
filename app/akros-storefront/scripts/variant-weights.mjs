/**
 * Unit weights from the AKROS source feed (`net_weight`, kg per sales unit), keyed by SKU.
 * OntOS merchandise has no variant weight yet, so the storefront reads this index (server only) to show
 * variant weights and the cart weight. Only positive weights of piece (`ks`) and metre (`m`) goods are kept;
 * zero, missing or other units stay unknown (Kai's approved rule, plans/akros-weight.plan.md).
 */
const weightUnits = new Set(["ks", "m"]);

export function buildVariantWeights(products) {
  const weights = new Map();
  const conflicting = new Set();
  const add = (sku, unit, kg) => {
    const key = String(sku ?? "")
      .trim()
      .toLowerCase();
    if (
      !key ||
      !weightUnits.has(
        String(unit ?? "")
          .trim()
          .toLowerCase(),
      )
    )
      return;
    if (typeof kg !== "number" || !Number.isFinite(kg) || kg <= 0) return;
    if (weights.has(key) && weights.get(key) !== kg) conflicting.add(key);
    weights.set(key, kg);
  };
  for (const product of products) {
    const variants = product.detail?.variants ?? [];
    if (variants.length === 0) add(product.sku, product.unit, product.netWeight);
    for (const variant of variants) add(variant.sku, variant.unit, variant.sourceNetWeight);
  }
  // A SKU with two different source weights is ambiguous: unknown, never a guess.
  for (const key of conflicting) weights.delete(key);
  return Object.fromEntries([...weights].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
