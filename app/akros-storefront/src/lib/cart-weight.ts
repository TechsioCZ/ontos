import type { CartState } from "@/features/cart/cart-state";

/**
 * Total cart weight from each line's `unitWeightKg` (kg per sales unit, set when the line is added and refreshed
 * by every OntOS cart quote). Lines without a valid weight are counted as missing, never as zero.
 */
export function getCartWeight(cart: CartState) {
  let knownKg = 0;
  let missingLines = 0;
  for (const line of cart.lines) {
    const weight = line.unitWeightKg;
    const lineWeight = (weight ?? NaN) * line.quantity;
    if (
      weight === undefined ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      !Number.isFinite(line.quantity) ||
      line.quantity <= 0 ||
      !Number.isFinite(lineWeight)
    ) {
      missingLines++;
    } else {
      knownKg += lineWeight;
    }
  }
  // Keep numeric overflow from being shown as a complete weight.
  if (!Number.isFinite(knownKg))
    return { knownKg: 0, missingLines: cart.lines.length, complete: false };
  return { knownKg, missingLines, complete: missingLines === 0 };
}
