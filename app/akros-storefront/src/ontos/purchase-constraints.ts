/** AKROS source minima are order increments; supplier packaging is a separate purchase shortcut. */
export function purchaseConstraints(minimumQuantity: number) {
  return { minimumQuantity, quantityStep: minimumQuantity };
}
