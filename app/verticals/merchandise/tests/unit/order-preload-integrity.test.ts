// @rstest-environment happy-dom
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { Effect, Result, Schema } from 'effect';
import { createElement } from 'react';
import { moduleChangeEvent, pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import {
  RecordsApi,
  OrderSchema,
  ProductRecordSchema,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  StockMovementSchema,
} from '../../shared/apis/records.ts';
import { mountInRoute } from '../support/module-ui.ts';
import {
  firstOrdersPage,
  forgetRememberedOrders,
  orderDetailData,
  ordersPageData,
  preloadOrderDetails,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';

const context = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const scope = pageDataScopeKey(context, 'demo.merchandise') ?? '';
const instant = '2026-10-15T10:00:00Z';
const order = Schema.decodeSync(OrderSchema)({
  createdAt: instant,
  id: 'order-1',
  lines: [
    {
      productId: 'product-1',
      productName: 'Cable',
      quantity: 2,
      sku: 'CABLE-BLACK',
      unitPriceMinor: 100,
      variantId: 'variant-1',
      vatRate: 21,
    },
  ],
  number: 'ORD-1',
  partyId: 'party-1',
  status: 'NEW',
  totalMinor: 200,
  totalVatMinor: 42,
  updatedAt: instant,
});
const summary = Schema.decodeSync(ProductRecordSchema)({
  active: true,
  category: 'IT',
  createdAt: instant,
  currentPriceMinor: 100,
  id: 'product-1',
  lowStock: false,
  lowStockThreshold: 0,
  name: 'Cable',
  priceHistory: [],
  sku: 'CABLE',
  stockOnHand: 10,
  stockValueMinor: 1000,
  unit: 'ks',
  updatedAt: instant,
  vatRate: 21,
});
const full = Schema.decodeSync(ProductRecordSchema)({
  ...Schema.encodeSync(ProductRecordSchema)(summary),
  variantRecords: [
    {
      active: true,
      attributes: 'black',
      availability: 'IN_STOCK',
      grossPriceMinor: 121,
      id: 'variant-1',
      name: 'Black cable',
      priceHistory: [],
      priceMinor: 100,
      sku: 'CABLE-BLACK',
      stockOnHand: 8,
    },
  ],
});
const movement = Schema.decodeSync(StockMovementSchema)({
  at: instant,
  delta: -2,
  id: 'movement-1',
  productId: 'product-1',
  reason: 'ORDER',
  reference: order.number,
});
const base = Schema.decodeSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  canWrite: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 200, orderCount: 1, productCount: 1, stockValueMinor: 1000 },
  movements: [],
  orders: [Schema.encodeSync(OrderSchema)(order)],
  products: [],
  revision: 7,
});
const source = { legalEntityId: context.legalEntityId, query: firstOrdersPage(2), scope };
const detail = { orderId: order.id, revision: 7, scope, source };
const denied = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});

const output = () => document.querySelector('output')?.outerHTML;
const reads: RecordsRequest[] = [];
const defaultAnswer = ({ view }: RecordsRequest): Effect.Effect<RecordsResponse> => {
  if (view?.productId !== undefined) {
    return Effect.succeed({ ...base, movements: [movement], orders: [], products: [summary] });
  }
  if (view?.productIds !== undefined) {
    return Effect.succeed({ ...base, orders: [], products: [view.summary === true ? summary : full] });
  }
  return Effect.succeed(base);
};
let answer: (request: RecordsRequest) => Effect.Effect<RecordsResponse, typeof denied> = defaultAnswer;
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.push(payload);
          return answer(payload);
        }),
      ),
    ),
  ),
);

beforeEach(() => {
  reads.length = 0;
  answer = defaultAnswer;
  forgetRememberedOrders();
  orderDetailData.invalidate();
  ordersPageData.invalidate();
});
afterEach(unmountAll);

it.live('the order hook cannot resurrect a retained ready page it holds no read of after strict invalidation', () =>
  Effect.gen(function* retainedHookState() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    const OrdersProbe = ({ offset }: { readonly offset: number }) =>
      createElement(
        'output',
        null,
        useOrders(context.legalEntityId, { ...source.query, offset }, context, { counts: false, warm: false }).state
          .kind,
      );
    const mounted = yield* mountInRoute(createElement(OrdersProbe, { offset: 0 }));
    expect(output()).toBe('<output>ready</output>');

    // Moving to a pending request clears useHeldSnapshot's key while useSettledPageData keeps the prior page.
    answer = () => Effect.never;
    yield* mounted.rerender(createElement(OrdersProbe, { offset: 2 }));
    expect(output()).toBe('<output>ready</output>');
    yield* acted(() => ordersPageData.invalidate());
    yield* mounted.rerender(createElement(OrdersProbe, { offset: 2 }));
    expect(output()).toBe('<output>loading</output>');
    answer = () => Effect.fail(denied);
    yield* ordersPageData.refresh({ ...source, query: { ...source.query, offset: 2 } });
    yield* waitUntil(() => output() === '<output>forbidden</output>');
    expect(output()).toBe('<output>forbidden</output>');
  }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
);

it.live('distinct request arrays cannot collide in the scoped order page key', () =>
  Effect.gen(function* distinctKeys() {
    yield* pinTestDocument;
    const first = { ...source, query: { ...source.query, taggedIds: ['a,b'] } };
    const second = { ...source, query: { ...source.query, taggedIds: ['a', 'b'] } };
    expect(ordersPageData.key(first)).not.toBe(ordersPageData.key(second));
  }).pipe(Effect.provide(network)),
);

it.live('invalidating the authorized order page immediately removes its rows and capabilities', () =>
  Effect.gen(function* strictPageInvalidation() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    expect(ordersPageData.snapshot(source).state).toBe('ready');
    ordersPageData.invalidate();
    expect(ordersPageData.snapshot(source)).toBe(pageDataPending);
    answer = () => Effect.fail(denied);
    yield* ordersPageData.refresh(source);
    expect(ordersPageData.snapshot(source)).toEqual({ error: denied, refreshing: false, state: 'failed' });
  }).pipe(Effect.provide(network)),
);

it.live('live changes clear the order list as well as the warmed detail', () =>
  Effect.gen(function* liveInvalidation() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    window.dispatchEvent(new CustomEvent(moduleChangeEvent));
    expect(ordersPageData.snapshot(source)).toBe(pageDataPending);
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
  }).pipe(Effect.provide(network)),
);

it.live('inactive order list pages have a finite cache bound', () =>
  Effect.gen(function* boundedLists() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    for (let page = 1; page <= 17; page += 1) {
      yield* ordersPageData.read({ ...source, query: { ...source.query, offset: page * 2 } });
    }
    expect(ordersPageData.snapshot(source)).toBe(pageDataPending);
  }).pipe(Effect.provide(network)),
);

it.live('a missing required product cannot be cached as a complete warm order', () =>
  Effect.gen(function* missingProduct() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    answer = () => Effect.succeed({ ...base, orders: [], products: [] });
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
    const outcome = yield* Effect.result(orderDetailData.read(detail));
    expect(Result.isFailure(outcome)).toBe(true);
  }).pipe(Effect.provide(network)),
);

it.live('a missing full variant product never falls back to a summary product', () =>
  Effect.gen(function* missingFullProduct() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    answer = ({ view }) => Effect.succeed({ ...base, orders: [], products: view?.summary === true ? [summary] : [] });
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
  }).pipe(Effect.provide(network)),
);

it.live('a full product missing the sold variant cannot mark the detail ready', () =>
  Effect.gen(function* missingVariant() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    answer = () => Effect.succeed({ ...base, orders: [], products: [summary] });
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
  }).pipe(Effect.provide(network)),
);

it.live('a complete warm order keeps the full variant read revision and retries after a partial result', () =>
  Effect.gen(function* enrichmentRevision() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    answer = () => Effect.fail(denied);
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
    answer = ({ view }) =>
      Effect.succeed({
        ...base,
        movements: view?.productId === undefined ? [] : [movement],
        orders: [],
        products: [view?.summary === true ? summary : full],
        revision: view?.summary === true ? 7 : 9,
      });
    const ready = yield* orderDetailData.read(detail);
    expect(ready).toEqual({ movesStock: true, order, products: [full], revision: 9, vat: { rates: [], regime: null } });
    reads.length = 0;
    expect(yield* orderDetailData.read(detail)).toBe(ready);
    expect(reads).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('a cold exact order link obtains the same complete product and revision data', () =>
  Effect.gen(function* coldOrderLink() {
    yield* pinTestDocument;
    answer = ({ view }) =>
      Effect.succeed({
        ...base,
        movements: view?.productId === undefined ? [] : [movement],
        products: view?.orderId === undefined ? [view?.summary === true ? summary : full] : [],
        revision: view?.summary === true ? 7 : 11,
      });
    const ready = yield* orderDetailData.read({ orderId: order.id, scope });
    expect(ready).toEqual({
      movesStock: true,
      order,
      products: [full],
      revision: 11,
      vat: { rates: [], regime: null },
    });
    expect(reads[0]?.view?.orderId).toBe(order.id);
  }).pipe(Effect.provide(network)),
);
