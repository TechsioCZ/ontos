import type { Order } from '../../../../../shared/apis/records.ts';
import type { OrderStatus } from '../../../../../shared/domain/merchandise-model.ts';
import { orderLineVatMinor } from '../../../../../shared/domain/order-totals.ts';
import type { OrdersSnapshot } from './orders-records.ts';

export const orderStatuses = [
  'NEW',
  'CONFIRMED',
  'PACKING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
] as const satisfies readonly OrderStatus[];

const nextStatuses = {
  CANCELLED: [],
  CONFIRMED: ['PACKING', 'SHIPPED', 'CANCELLED'],
  DELIVERED: [],
  NEW: ['CONFIRMED', 'CANCELLED'],
  PACKING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
} satisfies Record<OrderStatus, readonly OrderStatus[]>;

/** Statuses an order can move to. The forward step comes first; it is the primary action. */
export const transitionsFrom = (status: OrderStatus): readonly OrderStatus[] => nextStatuses[status];

/** A bulk choice must be legal for every selected order, including selections spanning pages. */
export const commonOrderTransitions = (orders: readonly Pick<Order, 'status'>[]): readonly OrderStatus[] => {
  const allowed = orders.map((order) => new Set(transitionsFrom(order.status)));
  return orders.length === 0 ? [] : orderStatuses.filter((next) => allowed.every((statuses) => statuses.has(next)));
};

const actionLabelKeys = {
  CANCELLED: 'merchandise.pages.orders.actions.cancel',
  CONFIRMED: 'merchandise.pages.orders.actions.confirm',
  DELIVERED: 'merchandise.pages.orders.actions.deliver',
  NEW: null,
  PACKING: 'merchandise.pages.orders.actions.pack',
  SHIPPED: 'merchandise.pages.orders.actions.ship',
} satisfies Record<OrderStatus, string | null>;

/** Button label for moving an order to `status`. `NEW` is never a target, so it has no label. */
export const actionLabelKey = (status: OrderStatus) => actionLabelKeys[status];

const statusDoneKeys = {
  CANCELLED: 'merchandise.pages.orders.toast.cancelled',
  CONFIRMED: 'merchandise.pages.orders.toast.confirmed',
  DELIVERED: 'merchandise.pages.orders.toast.delivered',
  NEW: null,
  PACKING: 'merchandise.pages.orders.toast.packing',
  SHIPPED: 'merchandise.pages.orders.toast.shipped',
} satisfies Record<OrderStatus, string | null>;

export const statusDoneKey = (status: OrderStatus) => statusDoneKeys[status];

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * Route-oriented values for a pending or loaded page. The header counts cover the whole company: totals and the
 * open value come from the indicators, cancelled and shipped from server counts (dashes until they land).
 */
export const ordersPageSummary = (snapshot: OrdersSnapshot | undefined) => {
  const orders = snapshot?.records.orders ?? [];
  return {
    canWrite: snapshot?.records.canWrite === true,
    orders,
    stats:
      snapshot === undefined
        ? undefined
        : {
            cancelled: snapshot.counts?.cancelled,
            openValueMinor: snapshot.records.indicators.openOrderValueMinor,
            shipped: snapshot.counts?.shipped,
            total: snapshot.records.indicators.orderCount,
          },
    totalOrders: snapshot?.records.totalOrders ?? orders.length,
  };
};

export interface LineAmounts {
  readonly gross: number;
  readonly net: number;
  readonly vat: number;
}

/**
 * Minor-unit amounts for one line, with the server's own per-line VAT rounding (`orderLineVatMinor`), so the preview
 * and the stored order agree. `vatRate` is the percentage Tax gives the line's classification; the server remains the
 * authority on totals.
 */
export const lineAmounts = (unitPriceMinor: number, quantity: number, vatRate: number): LineAmounts => {
  const net = unitPriceMinor * quantity;
  const vat = orderLineVatMinor({ quantity, unitPriceMinor, vatRate });
  return { gross: net + vat, net, vat };
};

export const sumAmounts = (amounts: readonly LineAmounts[]): LineAmounts => ({
  gross: sum(amounts.map((amount) => amount.gross)),
  net: sum(amounts.map((amount) => amount.net)),
  vat: sum(amounts.map((amount) => amount.vat)),
});
