/** The same catalog minimum/package/stock rules apply to changed staff quantities and storefront purchases.
 * Existing snapshots remain editable even after stock or packaging rules have changed. No reservation is made.
 */
export interface OrderQuantityRules {
  readonly minimum: number;
  readonly step: number;
  readonly packageRequired: boolean;
  readonly maximum: number;
}
export const orderQuantityRules = (unit: {
  readonly minimumQuantity?: number;
  readonly packageQuantity?: number;
  readonly stockOnHand: number;
}): OrderQuantityRules => ({
  minimum: unit.minimumQuantity ?? 1,
  step: unit.packageQuantity !== undefined && unit.packageQuantity > 0 ? unit.packageQuantity : 1,
  packageRequired: unit.packageQuantity !== undefined && unit.packageQuantity > 0,
  maximum: Math.min(1_000_000, Math.max(0, unit.stockOnHand)),
});
export const isOrderQuantityValid = (quantity: number, rules: OrderQuantityRules): boolean =>
  Number.isFinite(quantity) &&
  quantity >= rules.minimum &&
  quantity <= rules.maximum &&
  (!rules.packageRequired || Math.abs(quantity / rules.step - Math.round(quantity / rules.step)) <= 1e-6);
