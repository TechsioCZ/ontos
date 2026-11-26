import { orderLineVatMinor, vatInGrossMinor } from '@app/shared-contracts/order-line-amounts';
import type { Order, OrderLine } from './merchandise-model.ts';

export { lineGrossMinor, orderLineVatMinor, vatInGrossMinor } from '@app/shared-contracts/order-line-amounts';

type OrderLineAmounts = Pick<OrderLine, 'quantity' | 'unitPriceMinor' | 'vatRate'>;

/** Fixed demo order series; numbers are `OBJ-2026-0001`, `OBJ-2026-0002`, … (same convention as invoices). */
export const ORDER_NUMBER_PREFIX = 'OBJ-2026-';

/** Order totals: `totalMinor` is gross (net plus VAT), `totalVatMinor` is the VAT part. */
export const orderTotals = (lines: readonly OrderLineAmounts[]): Pick<Order, 'totalMinor' | 'totalVatMinor'> => {
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

/**
 * Totals of an order including its shipping. Gross-priced orders (storefront, `pricesIncludeVat`) sum gross
 * lines exactly, so the customer-visible total equals the sum of the shown line totals; net-priced staff orders
 * keep the original per-line VAT arithmetic. Shipping price is always gross.
 */
export const fullOrderTotals = (order: {
  readonly lines: readonly OrderLineAmounts[];
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
