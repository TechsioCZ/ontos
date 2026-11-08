import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Effect, Result, Schema } from 'effect';
import { createElement } from 'react';
import type ReactRuntime from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleChangeEvent, pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import {
  OrderSchema,
  ProductRecordSchema,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  StockMovementSchema,
} from '../../shared/apis/records.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import {
  firstOrdersPage,
  orderDetailData,
  ordersPageData,
  preloadOrderDetails,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import type { OrdersPageInput } from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
rstest.mock('../../src/api/change-order-status-action-client.ts');
// Reproduce useSettledPageData's retained prior render without running cold-mount effects.
const retained: {
  value?: {
    readonly input: OrdersPageInput;
    readonly snapshot: { readonly refreshing: boolean; readonly state: 'ready'; readonly value: RecordsResponse };
  };
} = rstest.hoisted(() => ({}));
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof ReactRuntime>('react'),
  useState: () => [retained.value, rstest.fn()],
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));
const events = new EventTarget();
const browserGlobals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};
beforeAll(() => {
  for (const [key, value] of Object.entries(browserGlobals)) {
    Reflect.set(globalThis, key, value);
  }
});
afterAll(() => {
  for (const key of Object.keys(browserGlobals)) {
    Reflect.deleteProperty(globalThis, key);
  }
});

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

beforeEach(() => {
  delete retained.value;
  rstest.resetAllMocks();
  orderDetailData.invalidate();
  ordersPageData.invalidate();
  rstest.mocked(executeRecords).mockImplementation(({ view }) => {
    if (view?.productId !== undefined) {
      return Effect.succeed({ ...base, movements: [movement], orders: [], products: [summary] });
    }
    if (view?.productIds !== undefined) {
      return Effect.succeed({ ...base, orders: [], products: [view.summary === true ? summary : full] });
    }
    return Effect.succeed(base);
  });
});

it.effect('the order hook cannot resurrect a retained ready page after strict invalidation', () =>
  Effect.gen(function* retainedHookState() {
    yield* ordersPageData.read(source);
    const prior = ordersPageData.snapshot(source);
    if (prior.state === 'ready') {
      retained.value = { input: source, snapshot: prior };
    }
    const OrdersProbe = () =>
      createElement('output', null, useOrders(context.legalEntityId, source.query, context).state.kind);
    expect(renderToStaticMarkup(createElement(OrdersProbe))).toBe('<output>ready</output>');
    ordersPageData.invalidate();
    expect(renderToStaticMarkup(createElement(OrdersProbe))).toBe('<output>loading</output>');
    rstest.mocked(executeRecords).mockReturnValue(Effect.fail(denied));
    yield* ordersPageData.refresh(source);
    expect(renderToStaticMarkup(createElement(OrdersProbe))).toBe('<output>forbidden</output>');
  }),
);

it.effect('distinct request arrays cannot collide in the scoped order page key', () =>
  Effect.sync(() => {
    const first = { ...source, query: { ...source.query, taggedIds: ['a,b'] } };
    const second = { ...source, query: { ...source.query, taggedIds: ['a', 'b'] } };
    expect(ordersPageData.key(first)).not.toBe(ordersPageData.key(second));
  }),
);

it.effect('invalidating the authorized order page immediately removes its rows and capabilities', () =>
  Effect.gen(function* strictPageInvalidation() {
    yield* ordersPageData.read(source);
    expect(ordersPageData.snapshot(source).state).toBe('ready');
    ordersPageData.invalidate();
    expect(ordersPageData.snapshot(source)).toBe(pageDataPending);
    rstest.mocked(executeRecords).mockReturnValue(Effect.fail(denied));
    yield* ordersPageData.refresh(source);
    expect(ordersPageData.snapshot(source)).toEqual({ error: denied, refreshing: false, state: 'failed' });
  }),
);

it.effect('live changes clear the order list as well as the warmed detail', () =>
  Effect.gen(function* liveInvalidation() {
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    globalThis.dispatchEvent(new Event(moduleChangeEvent));
    expect(ordersPageData.snapshot(source)).toBe(pageDataPending);
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
  }),
);

it.effect('inactive order list pages have a finite cache bound', () =>
  Effect.gen(function* boundedLists() {
    yield* ordersPageData.read(source);
    for (let page = 1; page <= 17; page += 1) {
      yield* ordersPageData.read({ ...source, query: { ...source.query, offset: page * 2 } });
    }
    expect(ordersPageData.snapshot(source)).toBe(pageDataPending);
  }),
);

it.effect('a missing required product cannot be cached as a complete warm order', () =>
  Effect.gen(function* missingProduct() {
    yield* ordersPageData.read(source);
    rstest.mocked(executeRecords).mockReturnValue(Effect.succeed({ ...base, orders: [], products: [] }));
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
    const outcome = yield* Effect.result(orderDetailData.read(detail));
    expect(Result.isFailure(outcome)).toBe(true);
  }),
);

it.effect('a missing full variant product never falls back to a summary product', () =>
  Effect.gen(function* missingFullProduct() {
    yield* ordersPageData.read(source);
    rstest
      .mocked(executeRecords)
      .mockImplementation(({ view }) =>
        Effect.succeed({ ...base, orders: [], products: view?.summary === true ? [summary] : [] }),
      );
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
  }),
);

it.effect('a full product missing the sold variant cannot mark the detail ready', () =>
  Effect.gen(function* missingVariant() {
    yield* ordersPageData.read(source);
    rstest
      .mocked(executeRecords)
      .mockImplementation(() => Effect.succeed({ ...base, orders: [], products: [summary] }));
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
  }),
);

it.effect('a complete warm order keeps the full variant read revision and retries after a partial result', () =>
  Effect.gen(function* enrichmentRevision() {
    yield* ordersPageData.read(source);
    rstest.mocked(executeRecords).mockReturnValue(Effect.fail(denied));
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
    rstest.mocked(executeRecords).mockImplementation(({ view }) =>
      Effect.succeed({
        ...base,
        movements: view?.productId === undefined ? [] : [movement],
        orders: [],
        products: [view?.summary === true ? summary : full],
        revision: view?.summary === true ? 7 : 9,
      }),
    );
    const ready = yield* orderDetailData.read(detail);
    expect(ready).toEqual({ movesStock: true, order, products: [full], revision: 9 });
    rstest.mocked(executeRecords).mockClear();
    expect(yield* orderDetailData.read(detail)).toBe(ready);
    expect(executeRecords).not.toHaveBeenCalled();
  }),
);

it.effect('a cold exact order link obtains the same complete product and revision data', () =>
  Effect.gen(function* coldOrderLink() {
    rstest.mocked(executeRecords).mockImplementation(({ view }) =>
      Effect.succeed({
        ...base,
        movements: view?.productId === undefined ? [] : [movement],
        products: view?.orderId === undefined ? [view?.summary === true ? summary : full] : [],
        revision: view?.summary === true ? 7 : 11,
      }),
    );
    const ready = yield* orderDetailData.read({ orderId: order.id, scope });
    expect(ready).toEqual({ movesStock: true, order, products: [full], revision: 11 });
    expect(rstest.mocked(executeRecords).mock.calls[0]?.[0].view?.orderId).toBe(order.id);
  }),
);
