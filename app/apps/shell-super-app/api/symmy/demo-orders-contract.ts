import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { MarketCurrencySchema } from '@app/merchandise/domain/market-offers';
import { Schema, Struct } from 'effect';

import { DemoOrderExportOrderSchema } from '@app/merchandise/apis/demo-order-export';
import type { DemoOrderExportResponse } from '@app/merchandise/apis/demo-order-export';
import { lineGrossMinor, orderLineVatMinor, vatInGrossMinor } from '@app/merchandise/domain/order-totals';

export const SymmyDemoOrdersQuerySchema = Schema.Struct({
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type SymmyDemoOrdersQuery = typeof SymmyDemoOrdersQuerySchema.Type;
/** HttpApi URL parameters decode strings; the dispatcher receives the numeric query above. */
export const SymmyDemoOrdersUrlQuerySchema = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: 100, minimum: 1 })),
  ),
  offset: Schema.optionalKey(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
});
export const SymmyDemoOrderIdSchema = DemoOrderExportOrderSchema.fields.id;

const orderFields = DemoOrderExportOrderSchema.fields;
const amount = orderFields.totalMinor;
const line = orderFields.lines.value;

export const SymmyDemoOrderSchema = Schema.Struct({
  ...Struct.pick(orderFields, [
    'billingAddress',
    'channel',
    'clientRequestId',
    'contact',
    'customerAccountId',
    'deliveryAddress',
    'deliveryRecipient',
    'demo',
    'id',
    'market',
    'note',
    'number',
    'partyId',
    'shipping',
    'status',
    'totalMinor',
    'totalVatMinor',
  ]),
  createdAt: orderFields.createdAt,
  currencyCode: MarketCurrencySchema,
  customerId: orderFields.partyId,
  lines: Schema.Array(
    Schema.Struct({
      ...line.fields,
      totalMinor: amount,
      totalVatMinor: amount,
    }),
  ),
  pricesIncludeVat: Schema.Boolean,
  totalNetMinor: amount,
  updatedAt: orderFields.updatedAt,
});
export const SymmyDemoOrdersResponseSchema = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 })),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  orders: Schema.Array(SymmyDemoOrderSchema),
});
export const SymmyDemoOrderResponseSchema = Schema.Struct({ order: SymmyDemoOrderSchema });
export const SymmyDemoOrderNotFoundProblemSchema = makeProblemDetailsSchema('SymmyDemoOrderNotFoundProblem', 404);
export const symmyDemoOrderNotFoundProblem = SymmyDemoOrderNotFoundProblemSchema.make({
  detail: 'The order was not found in the enrolled company.',
  status: SymmyDemoOrderNotFoundProblemSchema.fields.status.literal,
  title: 'Order not found',
  type: 'https://ontos.dev/problems/symmy-order-not-found',
});

/** Defense at the owner response boundary, including an empty page beyond the end of a collection. */
export const symmyDemoOrdersResultMatches = (
  result: DemoOrderExportResponse,
  expected: {
    readonly legalEntityId: string;
    readonly limit: number;
    readonly offset: number;
    readonly orderId?: string;
    readonly tenantId: string;
  },
): boolean =>
  result.tenantId === expected.tenantId &&
  result.legalEntityId === expected.legalEntityId &&
  result.orders.length <= expected.limit &&
  new Set(result.orders.map(({ id }) => id)).size === result.orders.length &&
  result.count >= result.orders.length &&
  (result.orders.length === 0 || result.count >= expected.offset + result.orders.length) &&
  (expected.orderId === undefined || (result.count <= 1 && result.orders.every(({ id }) => id === expected.orderId)));

/** IDs and monetary snapshots come from the persisted order, never from the current product price or Tax. */
export const mapSymmyDemoOrder = (
  order: DemoOrderExportResponse['orders'][number],
): typeof SymmyDemoOrderSchema.Type => {
  const { createdAt, lines, pricesIncludeVat = false, updatedAt, ...stored } = order;
  return {
    ...stored,
    createdAt,
    currencyCode: order.market?.currency ?? 'CZK',
    customerId: order.partyId,
    lines: lines.map((item) => {
      const totalMinor = lineGrossMinor(item, pricesIncludeVat);
      return {
        ...item,
        totalMinor,
        totalVatMinor: pricesIncludeVat ? vatInGrossMinor(totalMinor, item.vatRate) : orderLineVatMinor(item),
      };
    }),
    pricesIncludeVat,
    totalNetMinor: order.totalMinor - order.totalVatMinor,
    updatedAt,
  };
};
