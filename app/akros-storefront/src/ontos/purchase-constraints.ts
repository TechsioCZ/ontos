/** Owner minimum and mandatory packages, without borrowing prototype selling rules. */
export function purchaseConstraints(minimumQuantity: number, packageQuantity?: number) {
  const quantityStep = packageQuantity && packageQuantity > 0 ? packageQuantity : minimumQuantity;
  const minimum = Math.ceil(minimumQuantity / quantityStep - 0.000001) * quantityStep;
  return { minimumQuantity: Number(minimum.toFixed(6)), quantityStep };
}
