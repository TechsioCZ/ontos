/** Owner minimum and mandatory packages, without borrowing prototype selling rules. */
export function purchaseConstraints(minimumQuantity: number, packageQuantity?: number) {
  // An unpackaged minimum is only a lower bound. Default to individual sales units,
  // retaining the declared decimal precision for fractional-unit products.
  const decimals = minimumQuantity.toFixed(6).split(".")[1]?.replace(/0+$/u, "").length ?? 0;
  const quantityStep = packageQuantity && packageQuantity > 0 ? packageQuantity : 10 ** -decimals;
  const minimum = Math.ceil(minimumQuantity / quantityStep - 0.000001) * quantityStep;
  return { minimumQuantity: Number(minimum.toFixed(6)), quantityStep };
}
