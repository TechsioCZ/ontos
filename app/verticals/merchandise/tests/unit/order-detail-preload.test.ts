import { executeCleanupDemo } from '../../src/api/cleanup-demo-action-client.ts';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Deferred, Effect, Exit, Fiber, Schema } from 'effect';
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
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { ManageCatalogActionConflictProblemSchema } from '../../shared/apis/manage-catalog-action.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import {
  editOrder,
  firstOrdersPage,
  orderDetailData,
  ordersPageData,
  preloadOrderDetails,
  resetDemoData,
  useOrderDetail,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
// Execute the first-render branch without running effects. Customer coverage also mounts real React hooks.
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof ReactRuntime>('react'),
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

it.effect(
  'preloads the complete listed order, variants and ledger; opening reads synchronously without any request',
  () =>
    Effect.gen(function* preloadedOpen() {
      yield* ordersPageData.read(source);
      rstest.mocked(executeRecords).mockClear();
      yield* preloadOrderDetails(source, base);
      expect(executeRecords).toHaveBeenCalledTimes(3);
      expect(rstest.mocked(executeRecords).mock.calls.every(([request]) => request.view?.orderId === undefined)).toBe(
        true,
      );
      const ready = orderDetailData.snapshot(detail);
      expect(ready).toEqual({
        refreshing: false,
        state: 'ready',
        value: { movesStock: true, order, products: [full], revision: 7, vat: { rates: [], regime: null } },
      });
      rstest.mocked(executeRecords).mockClear();
      expect(orderDetailData.snapshot(detail)).toBe(ready);
      const OrderDetailProbe = () => {
        const state = useOrderDetail(order.id, 0, context, source);
        return createElement(
          'output',
          null,
          state.status === 'ready'
            ? [
                state.order.number,
                state.products[0]?.variantRecords?.[0]?.sku,
                state.movesStock ? 'stock-moved' : 'no-stock',
                String(state.revision),
              ].join('|')
            : state.status,
        );
      };
      expect(renderToStaticMarkup(createElement(OrderDetailProbe))).toBe(
        '<output>ORD-1|CABLE-BLACK|stock-moved|7</output>',
      );
      expect(yield* orderDetailData.read(detail)).toEqual({
        movesStock: true,
        order,
        products: [full],
        revision: 7,
        vat: { rates: [], regime: null },
      });
      expect(executeRecords).not.toHaveBeenCalled();
    }),
);

it.effect('concurrent prefetches and foreground selection join the same enrichment', () =>
  Effect.gen(function* deduplication() {
    yield* ordersPageData.read(source);
    const gate = yield* Deferred.make<true>();
    rstest
      .mocked(executeRecords)
      .mockImplementation(() => Deferred.await(gate).pipe(Effect.as({ ...base, products: [full] })));
    const prefetch = yield* Effect.forkChild(preloadOrderDetails(source, base));
    yield* Effect.yieldNow;
    const foreground = yield* Effect.forkChild(orderDetailData.read(detail));
    yield* Effect.yieldNow;
    yield* Deferred.succeed(gate, true);
    yield* Fiber.join(prefetch);
    yield* Fiber.join(foreground);
    // One summary, one variant read and one ledger, not two sets.
    expect(executeRecords).toHaveBeenCalledTimes(4);
  }),
);

it.effect('a write preserves the caller revision, invalidates the row and refetches governed data', () =>
  Effect.gen(function* writeInvalidation() {
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    rstest
      .mocked(executeManageCatalog)
      .mockReturnValue(
        Effect.succeed(Schema.decodeSync(ApplyCommandResultSchema)({ entityIds: [order.id], revision: 8 })),
      );
    yield* editOrder({ _tag: 'EditOrder', id: order.id, note: 'Changed' }, 7);
    expect(rstest.mocked(executeManageCatalog).mock.calls[0]?.[0].expectedRevision).toBe(7);
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
    rstest.mocked(executeRecords).mockClear();
    yield* orderDetailData.read(detail);
    expect(executeRecords).toHaveBeenCalledTimes(4);
  }),
);

it.effect('reset and rejected writes also invalidate details without changing the submitted revision', () =>
  Effect.gen(function* resetAndConflict() {
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    rstest
      .mocked(executeCleanupDemo)
      .mockReturnValue(Effect.succeed(Schema.decodeSync(ApplyCommandResultSchema)({ entityIds: [], revision: 8 })));
    yield* resetDemoData('Reset proof', 7);
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
    expect(rstest.mocked(executeCleanupDemo).mock.calls[0]?.[0]).toEqual({
      command: { _tag: 'ResetDemoData', confirmation: 'OBNOVIT', reason: 'Reset proof' },
      expectedRevision: 7,
    });
    yield* orderDetailData.read(detail);
    const conflict = yield* Schema.decodeEffect(ManageCatalogActionConflictProblemSchema)({
      _tag: 'ManageCatalogActionConflictProblem',
      code: 'merchandise_revision_conflict',
      detail: 'Changed',
      status: 409,
      title: 'Conflict',
      type: 'urn:test:conflict',
    });
    rstest.mocked(executeManageCatalog).mockReturnValue(Effect.fail(conflict));
    yield* Effect.exit(editOrder({ _tag: 'EditOrder', id: order.id, note: 'Not saved' }, 7));
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
    expect(rstest.mocked(executeManageCatalog).mock.calls[0]?.[0].expectedRevision).toBe(7);
  }),
);

it.effect('authorization change never serves stale order data, and a subsequent allowed read retries', () =>
  Effect.gen(function* authorizationChange() {
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    globalThis.dispatchEvent(new Event(moduleChangeEvent));
    rstest.mocked(executeRecords).mockReturnValue(Effect.fail(denied));
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
    const rejected = yield* Effect.exit(orderDetailData.read(detail));
    expect(Exit.isFailure(rejected)).toBe(true);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
    rstest.mocked(executeRecords).mockReturnValue(Effect.succeed({ ...base, products: [full] }));
    yield* orderDetailData.read(detail);
    expect(orderDetailData.snapshot(detail).state).toBe('ready');
  }),
);

it.effect('unknown orders do not acquire fixture data or a reusable negative result', () =>
  Effect.gen(function* unknownOrder() {
    const unknown = { orderId: 'missing', scope };
    rstest.mocked(executeRecords).mockReturnValue(Effect.succeed({ ...base, orders: [] }));
    yield* Effect.exit(orderDetailData.read(unknown));
    expect(orderDetailData.snapshot(unknown).state).toBe('failed');
    yield* Effect.exit(orderDetailData.read(unknown));
    expect(executeRecords).toHaveBeenCalledTimes(2);
  }),
);

it.effect('different companies, tenants and users never consume the warmed record', () =>
  Effect.gen(function* isolation() {
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    for (const field of ['legalEntityId', 'tenantId', 'principalId'] as const) {
      const otherScope = pageDataScopeKey({ ...context, [field]: 'other' }, 'demo.merchandise') ?? '';
      expect(orderDetailData.snapshot({ ...detail, scope: otherScope })).toBe(pageDataPending);
    }
    yield* preloadOrderDetails({ legalEntityId: source.legalEntityId, query: source.query }, base);
    expect(orderDetailData.snapshot({ ...detail, scope: '' })).toBe(pageDataPending);
  }),
);

it.effect('only current-page rows are prefetched and cancellation stops queued rows', () =>
  Effect.gen(function* boundedPrefetch() {
    const gate = yield* Deferred.make<true>();
    const started = yield* Deferred.make<true>();
    let requests = 0;
    const records = {
      ...base,
      orders: Array.from({ length: 6 }, (_, index) => ({
        ...order,
        id: Schema.decodeSync(OrderSchema.fields.id)(`order-${index}`),
      })),
    };
    rstest.mocked(executeRecords).mockImplementation(({ view }) =>
      view?.productIds === undefined
        ? Effect.succeed(records)
        : Effect.sync(() => {
            requests += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(started, true)),
            Effect.andThen(Deferred.await(gate)),
            Effect.as(base),
          ),
    );
    const currentPage = { ...source, query: { ...source.query, limit: 4 } };
    const prefetch = yield* Effect.forkChild(preloadOrderDetails(currentPage, records));
    yield* Deferred.await(started);
    yield* Effect.yieldNow;
    expect(requests).toBe(2);
    yield* Fiber.interrupt(prefetch);
    expect(requests).toBe(2);
    yield* Deferred.succeed(gate, true);
    yield* Effect.yieldNow;
    expect(requests).toBe(2);
  }),
);
