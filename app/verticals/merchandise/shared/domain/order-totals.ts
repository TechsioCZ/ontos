import type { Order, OrderLine } from './merchandise-model.ts';

/** Fixed demo order series; numbers are `OBJ-2026-0001`, `OBJ-2026-0002`, … (same convention as invoices). */
export const ORDER_NUMBER_PREFIX = 'OBJ-2026-';

/**
 * Line VAT in whole minor units, rounded half-up. Unit prices are net; VAT is computed per line from the
 * snapshot rate, matching siampark-billing-finance so an order and its invoice agree on the same arithmetic.
 */
export const orderLineVatMinor = (line: Pick<OrderLine, 'quantity' | 'unitPriceMinor' | 'vatRate'>): number =>
  Math.floor((line.quantity * line.unitPriceMinor * line.vatRate + 50) / 100);

/** Order totals: `totalMinor` is gross (net plus VAT), `totalVatMinor` is the VAT part. */
export const orderTotals = (lines: readonly OrderLine[]): Pick<Order, 'totalMinor' | 'totalVatMinor'> => {
  let netMinor = 0;
  let totalVatMinor = 0;
  for (const line of lines) {
    netMinor += line.quantity * line.unitPriceMinor;
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
