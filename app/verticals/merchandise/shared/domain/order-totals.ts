import type { Order, OrderLine } from './merchandise-model.ts';

/** Fixed demo order series; numbers are `OBJ-2026-0001`, `OBJ-2026-0002`, … (same convention as invoices). */
export const ORDER_NUMBER_PREFIX = 'OBJ-2026-';

/**
 * Line VAT in whole minor units, rounded half-up. Unit prices are net; VAT is computed per line from the
 * snapshot rate, matching finance-billing so an order and its invoice agree on the same arithmetic.
 */
export const orderLineVatMinor = (line: Pick<OrderLine, 'quantity' | 'unitPriceMinor' | 'vatRate'>): number =>
  Math.floor((line.quantity * line.unitPriceMinor * line.vatRate + 50) / 100);

/** Order totals: `totalMinor` is gross (net plus VAT), `totalVatMinor` is the VAT part. */
export const orderTotals = (lines: readonly OrderLine[]): Pick<Order, 'totalMinor' | 'totalVatMinor'> => {
  let netMinor = 0;
  let totalVatMinor = 0;
  for (const line of lines) {
    netMinor += Math.round(line.quantity * line.unitPriceMinor);
    totalVatMinor += orderLineVatMinor(line);
  }
  return { totalMinor: netMinor + totalVatMinor, totalVatMinor };
};

/** Next number of the order series, above every number already present so cancelled orders keep theirs. */
export const nextOrderNumber = (existing: readonly Pick<Order, 'number'>[]): string => {
  let highest = 0;
  for (const order of existing) {
    if (order.number.startsWith(ORDER_NUMBER_PREFIX)) {
      const sequence = Number(order.number.slice(ORDER_NUMBER_PREFIX.length));
      if (Number.isSafeInteger(sequence) && sequence > highest) {
        highest = sequence;
      }
    }
  }
  return `${ORDER_NUMBER_PREFIX}${String(highest + 1).padStart(4, '0')}`;
};

/** VAT part contained in a gross amount, rounded half-up: gross − gross / (1 + rate). */
export const vatInGrossMinor = (grossMinor: number, vatRate: number): number =>
  grossMinor - Math.floor((grossMinor * 100 + (100 + vatRate) / 2) / (100 + vatRate));

/**
 * Totals of an order including its shipping. Gross-priced orders (storefront, `pricesIncludeVat`) sum gross
 * lines exactly, so the customer-visible total equals the sum of the shown line totals; net-priced staff orders
 * keep the original per-line VAT arithmetic. Shipping price is always gross.
 */
export const fullOrderTotals = (order: {
  readonly lines: readonly OrderLine[];
  readonly pricesIncludeVat?: boolean | undefined;
  readonly shipping?: Order['shipping'] | undefined;
}): Pick<Order, 'totalMinor' | 'totalVatMinor'> => {
  const shippingGross = order.shipping?.priceMinor ?? 0;
  const shippingVat = order.shipping === undefined ? 0 : vatInGrossMinor(shippingGross, order.shipping.vatRate);
  if (order.pricesIncludeVat !== true) {
    const base = orderTotals(order.lines);
    return { totalMinor: base.totalMinor + shippingGross, totalVatMinor: base.totalVatMinor + shippingVat };
  }
  let totalMinor = shippingGross;
  let totalVatMinor = shippingVat;
  for (const line of order.lines) {
    const gross = Math.round(line.quantity * line.unitPriceMinor);
    totalMinor += gross;
    totalVatMinor += vatInGrossMinor(gross, line.vatRate);
  }
  return { totalMinor, totalVatMinor };
};

/** Gross total of one line as shown to a customer or in the admin detail. */
export const lineGrossMinor = (
  line: Pick<OrderLine, 'quantity' | 'unitPriceMinor' | 'vatRate'>,
  pricesIncludeVat: boolean | undefined,
): number =>
  pricesIncludeVat === true
    ? Math.round(line.quantity * line.unitPriceMinor)
    : Math.round(line.quantity * line.unitPriceMinor) + orderLineVatMinor(line);
