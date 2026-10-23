import type { CartState } from "@/mock-storefront/cart";
import { getProductUnitWeightKg } from "@/mock-storefront/catalog";

export function getCartWeight(cart: CartState) {
  let knownKg = 0;
  let missingLines = 0;
  for (const line of cart.lines) {
    const weight = line.unitWeightKg ?? getProductUnitWeightKg(line);
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
