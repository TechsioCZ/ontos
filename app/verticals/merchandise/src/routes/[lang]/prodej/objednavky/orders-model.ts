import { DateTime } from 'effect';
import type { Order } from '../../../../../shared/apis/records.ts';
import type { OrderStatus, VatRate } from '../../../../../shared/domain/merchandise-model.ts';

export const orderStatuses = [
  'NEW',
  'CONFIRMED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
] as const satisfies readonly OrderStatus[];

const nextStatuses = {
  CANCELLED: [],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  DELIVERED: [],
  NEW: ['CONFIRMED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
} satisfies Record<OrderStatus, readonly OrderStatus[]>;

/** Statuses an order can move to. The forward step comes first; it is the primary action. */
export const transitionsFrom = (status: OrderStatus): readonly OrderStatus[] => nextStatuses[status];

const actionLabelKeys = {
  CANCELLED: 'merchandise.pages.orders.actions.cancel',
  CONFIRMED: 'merchandise.pages.orders.actions.confirm',
  DELIVERED: 'merchandise.pages.orders.actions.deliver',
  NEW: null,
  SHIPPED: 'merchandise.pages.orders.actions.ship',
} satisfies Record<OrderStatus, string | null>;

/** Button label for moving an order to `status`. `NEW` is never a target, so it has no label. */
export const actionLabelKey = (status: OrderStatus) => actionLabelKeys[status];

const statusDoneKeys = {
  CANCELLED: 'merchandise.pages.orders.toast.cancelled',
  CONFIRMED: 'merchandise.pages.orders.toast.confirmed',
  DELIVERED: 'merchandise.pages.orders.toast.delivered',
  NEW: null,
  SHIPPED: 'merchandise.pages.orders.toast.shipped',
} satisfies Record<OrderStatus, string | null>;

export const statusDoneKey = (status: OrderStatus) => statusDoneKeys[status];

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

const sameUtcMonth = (left: DateTime.Utc, right: DateTime.Utc) =>
  DateTime.getPartUtc(left, 'year') === DateTime.getPartUtc(right, 'year') &&
  DateTime.getPartUtc(left, 'month') === DateTime.getPartUtc(right, 'month');

/**
 * Header statistics over all loaded orders. "Shipped this month" uses `updatedAt` as its date because
 * the order carries no shipping timestamp yet.
 */
export const orderStats = (orders: readonly Order[], now: DateTime.Utc) => {
  const open = orders.filter((order) => order.status === 'NEW' || order.status === 'CONFIRMED');
  return {
    cancelled: orders.filter((order) => order.status === 'CANCELLED').length,
    openCount: open.length,
    openValueMinor: sum(open.map((order) => order.totalMinor)),
    shippedThisMonth: orders.filter((order) => order.status === 'SHIPPED' && sameUtcMonth(order.updatedAt, now)).length,
    total: orders.length,
  };
};

export interface LineAmounts {
  readonly gross: number;
  readonly net: number;
  readonly vat: number;
}

/** Minor-unit amounts for one line. VAT is rounded per line; the server remains the authority on totals. */
export const lineAmounts = (unitPriceMinor: number, quantity: number, vatRate: VatRate): LineAmounts => {
  const net = unitPriceMinor * quantity;
  const vat = Math.round((net * vatRate) / 100);
  return { gross: net + vat, net, vat };
};

export const sumAmounts = (amounts: readonly LineAmounts[]): LineAmounts => ({
  gross: sum(amounts.map((amount) => amount.gross)),
  net: sum(amounts.map((amount) => amount.net)),
  vat: sum(amounts.map((amount) => amount.vat)),
});
