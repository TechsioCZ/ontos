/** Pricing inputs needed to project a persisted order line, regardless of its owner. */
interface OrderLineAmounts {
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly vatRate: number;
}

/**
 * Line VAT in whole minor units, rounded half-up. Unit prices are net; VAT is computed per line from the
 * snapshot rate, matching finance-billing so an order and its invoice agree on the same arithmetic.
 */
export const orderLineVatMinor = (line: OrderLineAmounts): number =>
  Math.floor((line.quantity * line.unitPriceMinor * line.vatRate + 50) / 100);

/** VAT part contained in a gross amount, rounded half-up: gross − gross / (1 + rate). */
export const vatInGrossMinor = (grossMinor: number, vatRate: number): number =>
  grossMinor - Math.floor((grossMinor * 100 + (100 + vatRate) / 2) / (100 + vatRate));

/** Gross total of one line as shown to a customer or in the admin detail. */
export const lineGrossMinor = (line: OrderLineAmounts, pricesIncludeVat = false): number =>
  pricesIncludeVat
    ? Math.round(line.quantity * line.unitPriceMinor)
    : Math.round(line.quantity * line.unitPriceMinor) + orderLineVatMinor(line);
