// @rstest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from 'effect';
import { createElement } from 'react';
import { settle, unmountAll } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { moduleChangeEvent, pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import {
  OrderSchema,
  ProductRecordSchema,
  RecordsApi,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  StockMovementSchema,
} from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import {
  ManageCatalogActionApi,
  ManageCatalogActionConflictProblemSchema,
} from '../../shared/apis/manage-catalog-action.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/apis/manage-catalog-action.ts';
import { CleanupDemoActionApi } from '../../shared/apis/cleanup-demo-action.ts';
import type { CleanupDemoPayloadSchema } from '../../shared/apis/cleanup-demo-action.ts';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import { cleanupDemoActionSchemaErrorLive } from '../../api/cleanup-demo-action-problems.ts';
import { mountInRoute } from '../support/module-ui.ts';
import {
  editOrder,
  firstOrdersPage,
  orderDetailData,
  ordersPageData,
  preloadOrderDetails,
  resetDemoData,
  useOrderDetail,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';

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

const reads: RecordsRequest[] = [];
const catalogWrites: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
const cleanupWrites: (typeof CleanupDemoPayloadSchema.Encoded)[] = [];
const defaultRecords = ({ view }: RecordsRequest) => {
  if (view?.productId !== undefined) {
    return Effect.succeed({ ...base, movements: [movement], orders: [], products: [summary] });
  }
  if (view?.productIds !== undefined) {
    return Effect.succeed({ ...base, orders: [], products: [view.summary === true ? summary : full] });
  }
  return Effect.succeed(base);
};
let recordsAnswer: (request: RecordsRequest) => Effect.Effect<RecordsResponse, typeof denied> = defaultRecords;
const saved = Schema.decodeSync(ApplyCommandResultSchema)({ entityIds: [order.id], revision: 8 });
let catalogAnswer: Effect.Effect<typeof saved, typeof ManageCatalogActionConflictProblemSchema.Type> =
  Effect.succeed(saved);
let cleanupAnswer = Effect.succeed(Schema.decodeSync(ApplyCommandResultSchema)({ entityIds: [], revision: 8 }));
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const OwnerCatalogApi = ManageCatalogActionApi.prefix('/merchandise-api');
const OwnerCleanupApi = CleanupDemoActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
        }).pipe(Effect.andThen(Effect.suspend(() => recordsAnswer(payload)))),
      ),
    ),
  ),
  serveApi(
    OwnerCatalogApi,
    HttpApiBuilder.group(OwnerCatalogApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          catalogWrites.push(payload);
        }).pipe(Effect.andThen(Effect.suspend(() => catalogAnswer))),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerCleanupApi,
    HttpApiBuilder.group(OwnerCleanupApi, 'cleanupDemoAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          cleanupWrites.push(payload);
        }).pipe(Effect.andThen(Effect.suspend(() => cleanupAnswer))),
      ),
    ).pipe(Layer.provide(cleanupDemoActionSchemaErrorLive)),
  ),
);

beforeEach(() => {
  reads.length = 0;
  catalogWrites.length = 0;
  cleanupWrites.length = 0;
  orderDetailData.invalidate();
  ordersPageData.invalidate();
  recordsAnswer = defaultRecords;
  catalogAnswer = Effect.succeed(saved);
  cleanupAnswer = Effect.succeed(Schema.decodeSync(ApplyCommandResultSchema)({ entityIds: [], revision: 8 }));
});
afterEach(unmountAll);

it.live(
  'preloads the complete listed order, variants and ledger; opening reads synchronously without any request',
  () =>
    Effect.gen(function* preloadedOpen() {
      yield* pinTestDocument;
      yield* ordersPageData.read(source);
      reads.length = 0;
      yield* preloadOrderDetails(source, base);
      expect(reads).toHaveLength(3);
      expect(reads.every((request) => request.view?.orderId === undefined)).toBe(true);
      const ready = orderDetailData.snapshot(detail);
      expect(ready).toEqual({
        refreshing: false,
        state: 'ready',
        value: { movesStock: true, order, products: [full], revision: 7, vat: { rates: [], regime: null } },
      });
      reads.length = 0;
      expect(orderDetailData.snapshot(detail)).toBe(ready);
      const renderedStates: ReturnType<typeof useOrderDetail>[] = [];
      const OrderDetailProbe = () => {
        const state = useOrderDetail(order.id, 0, context, source);
        renderedStates.push(state);
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
      yield* mountInRoute(createElement(OrderDetailProbe));
      expect(renderedStates[0]).toMatchObject({ status: 'ready' });
      expect(document.querySelector('output')?.outerHTML).toBe('<output>ORD-1|CABLE-BLACK|stock-moved|7</output>');
      expect(yield* orderDetailData.read(detail)).toEqual({
        movesStock: true,
        order,
        products: [full],
        revision: 7,
        vat: { rates: [], regime: null },
      });
      expect(reads).toHaveLength(0);
    }).pipe(Effect.provide(network)),
);

it.live('a write preserves the caller revision, invalidates the row and refetches governed data', () =>
  Effect.gen(function* writeInvalidation() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    catalogAnswer = Effect.succeed(saved);
    yield* editOrder({ _tag: 'EditOrder', id: order.id, note: 'Changed' }, 7);
    expect(catalogWrites[0]?.expectedRevision).toBe(7);
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
    reads.length = 0;
    yield* orderDetailData.read(detail);
    expect(reads).toHaveLength(4);
  }).pipe(Effect.provide(network)),
);

it.live('reset and rejected writes also invalidate details without changing the submitted revision', () =>
  Effect.gen(function* resetAndConflict() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    cleanupAnswer = Effect.succeed(Schema.decodeSync(ApplyCommandResultSchema)({ entityIds: [], revision: 8 }));
    yield* resetDemoData('Reset proof', 7);
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
    expect(cleanupWrites[0]).toEqual({
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
    catalogAnswer = Effect.fail(conflict);
    yield* Effect.exit(editOrder({ _tag: 'EditOrder', id: order.id, note: 'Not saved' }, 7));
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
    expect(catalogWrites[0]?.expectedRevision).toBe(7);
  }).pipe(Effect.provide(network)),
);

it.live('authorization change never serves stale order data, and a subsequent allowed read retries', () =>
  Effect.gen(function* authorizationChange() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    window.dispatchEvent(new Event(moduleChangeEvent));
    recordsAnswer = () => Effect.fail(denied);
    expect(orderDetailData.snapshot(detail)).toBe(pageDataPending);
    const rejected = yield* Effect.exit(orderDetailData.read(detail));
    expect(Exit.isFailure(rejected)).toBe(true);
    expect(orderDetailData.snapshot(detail).state).toBe('failed');
    recordsAnswer = () => Effect.succeed({ ...base, products: [full] });
    yield* orderDetailData.read(detail);
    expect(orderDetailData.snapshot(detail).state).toBe('ready');
  }).pipe(Effect.provide(network)),
);

it.live('unknown orders do not acquire fixture data or a reusable negative result', () =>
  Effect.gen(function* unknownOrder() {
    yield* pinTestDocument;
    const unknown = { orderId: 'missing', scope };
    recordsAnswer = () => Effect.succeed({ ...base, orders: [] });
    yield* Effect.exit(orderDetailData.read(unknown));
    expect(orderDetailData.snapshot(unknown).state).toBe('failed');
    yield* Effect.exit(orderDetailData.read(unknown));
    expect(reads).toHaveLength(2);
  }).pipe(Effect.provide(network)),
);

it.live('different companies, tenants and users never consume the warmed record', () =>
  Effect.gen(function* isolation() {
    yield* pinTestDocument;
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    for (const field of ['legalEntityId', 'tenantId', 'principalId'] as const) {
      const otherScope = pageDataScopeKey({ ...context, [field]: 'other' }, 'demo.merchandise') ?? '';
      expect(orderDetailData.snapshot({ ...detail, scope: otherScope })).toBe(pageDataPending);
    }
    yield* preloadOrderDetails({ legalEntityId: source.legalEntityId, query: source.query }, base);
    expect(orderDetailData.snapshot({ ...detail, scope: '' })).toBe(pageDataPending);
  }).pipe(Effect.provide(network)),
);

it.live('only current-page rows are prefetched and cancellation stops queued rows', () =>
  Effect.gen(function* boundedPrefetch() {
    yield* pinTestDocument;
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
    recordsAnswer = ({ view }) =>
      view?.productIds === undefined
        ? Effect.succeed(records)
        : Effect.sync(() => {
            requests += 1;
          }).pipe(
            Effect.andThen(Effect.suspend(() => (requests === 2 ? Deferred.succeed(started, true) : Effect.void))),
            Effect.andThen(Deferred.await(gate)),
            Effect.as(base),
          );
    const currentPage = { ...source, query: { ...source.query, limit: 4 } };
    const prefetch = yield* Effect.forkChild(preloadOrderDetails(currentPage, records));
    yield* Deferred.await(started);
    yield* Effect.yieldNow;
    expect(requests).toBe(2);
    yield* Fiber.interrupt(prefetch);
    expect(requests).toBe(2);
    yield* Deferred.succeed(gate, true);
    yield* settle;
    expect(requests).toBe(2);
  }).pipe(Effect.provide(network)),
);
