/** The same catalog minimum/package/stock rules apply to changed staff quantities and storefront purchases.
 * Existing snapshots remain editable even after stock or packaging rules have changed. No reservation is made.
 */
export interface OrderQuantityRules {
  readonly maximum: number;
  readonly minimum: number;
  readonly packageRequired: boolean;
  readonly step: number;
}
/** Only the edited order's matching, already-debited line can be added back to available stock. */
export const orderQuantityRules = (
  unit: {
    readonly minimumQuantity?: number;
    readonly packageQuantity?: number;
    readonly stockOnHand: number;
  },
  alreadyDebitedQuantity = 0,
): OrderQuantityRules => ({
  maximum: Math.min(1_000_000, Math.max(0, unit.stockOnHand + alreadyDebitedQuantity)),
  minimum: unit.minimumQuantity ?? 1,
  packageRequired: unit.packageQuantity !== undefined && unit.packageQuantity > 0,
  step: unit.packageQuantity !== undefined && unit.packageQuantity > 0 ? unit.packageQuantity : 1,
});
export const isOrderQuantityValid = (quantity: number, rules: OrderQuantityRules): boolean =>
  Number.isFinite(quantity) &&
  quantity >= rules.minimum &&
  quantity <= rules.maximum &&
  (!rules.packageRequired || Math.abs(quantity / rules.step - Math.round(quantity / rules.step)) <= 1e-6);
