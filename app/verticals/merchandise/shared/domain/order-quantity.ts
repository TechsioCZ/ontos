/** Quantities are stored and compared to six decimal places, independently of money rounding. */
export const QUANTITY_DECIMAL_PLACES = 6;
export const MAX_QUANTITY = 1_000_000;
const quantityScale = 10 ** QUANTITY_DECIMAL_PLACES;
export const MIN_STOCK_QUANTITY = 1 / quantityScale;

export const normalizeQuantity = (quantity: number): number => Math.round(quantity * quantityScale) / quantityScale;
export const hasQuantityPrecision = (quantity: number): boolean =>
  Number.isFinite(quantity) &&
  Math.abs(quantity - normalizeQuantity(quantity)) <= Number.EPSILON * Math.max(1, Math.abs(quantity));
export const isStockQuantity = (quantity: number): boolean =>
  hasQuantityPrecision(quantity) && Math.abs(quantity) >= MIN_STOCK_QUANTITY && Math.abs(quantity) <= MAX_QUANTITY;
export const isQuantityMultipleOf = (quantity: number, step: number): boolean =>
  normalizeQuantity(quantity - Math.round(quantity / step) * step) === 0;

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
  maximum: Math.min(MAX_QUANTITY, Math.max(0, normalizeQuantity(unit.stockOnHand + alreadyDebitedQuantity))),
  minimum: unit.minimumQuantity ?? 1,
  packageRequired: unit.packageQuantity !== undefined && unit.packageQuantity > 0,
  step: unit.packageQuantity !== undefined && unit.packageQuantity > 0 ? unit.packageQuantity : 1,
});
export const isOrderQuantityValid = (quantity: number, rules: OrderQuantityRules): boolean =>
  hasQuantityPrecision(quantity) &&
  normalizeQuantity(quantity) >= normalizeQuantity(rules.minimum) &&
  normalizeQuantity(quantity) <= normalizeQuantity(rules.maximum) &&
  (!rules.packageRequired || isQuantityMultipleOf(quantity, rules.step));
