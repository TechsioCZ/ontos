import { firstOrderableQuantity } from "@app/merchandise/domain/order-quantity";

/**
 * The owner's order rule (merchandise order-quantity): a unit sold in packages is ordered from its
 * first whole package in whole packages; an unpackaged AKROS source minimum is its order increment.
 */
export function purchaseConstraints(minimumQuantity: number, packageQuantity?: number) {
  return packageQuantity !== undefined && packageQuantity > 0
    ? {
        minimumQuantity: firstOrderableQuantity({ minimumQuantity, packageQuantity }),
        quantityStep: packageQuantity,
      }
    : { minimumQuantity, quantityStep: minimumQuantity };
}
