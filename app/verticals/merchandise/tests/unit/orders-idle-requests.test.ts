// @rstest-environment happy-dom
// How many records reads an idle orders list sends: the real `useOrders` hook over the real strict stores,
// the in-process owner HTTP API and fake timers. The list reloads its page after the 20 s freshness
// window and after a live change of merchandise. The details warmed for its rows are read once per list
// revision, not again whenever the page reload settles, and live changes of unrelated modules read nothing.
import { passFakeTime, text, waitUntilOnFakeTimers } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { moduleChangeEvent, pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { OrderSchema, ProductRecordSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { OrderIdSchema } from '../../shared/domain/merchandise-model.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { ManageCatalogActionApi } from '../../shared/apis/manage-catalog-action.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/apis/manage-catalog-action.ts';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import { customerDirectoryData } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import {
  editOrder,
  firstOrdersPage,
  orderCountsData,
  orderDetailData,
  orderDetailIntent,
  ordersPageData,
  useOrderDetail,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import type { OrdersPageInput } from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { LIST_WARM_ROWS } from '@app/admin-ui';

const company: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const PAGE_SIZE = 50;
const ROWS = 10;

const orders = Array.from({ length: ROWS }, (_, index) =>
  Schema.encodeSync(OrderSchema)(
    Schema.decodeSync(OrderSchema)({
      createdAt: instant,
      id: `order-${index + 1}`,
      lines: [
        {
          productId: 'product-1',
          productName: 'Cable',
          quantity: 1,
          sku: 'CABLE',
          unitPriceMinor: 100,
          vatRate: 21,
        },
      ],
      number: `ORD-${index + 1}`,
      partyId: 'party-1',
      status: 'NEW',
      totalMinor: 100,
      totalVatMinor: 21,
      updatedAt: instant,
    }),
  ),
);
const product = Schema.encodeSync(ProductRecordSchema)(
  Schema.decodeSync(ProductRecordSchema)({
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
  }),
);

/** The owner's current revision, advanced when another write changes the register. */
const register = { note: '', revision: 7 };
const responseOf = (rows: { readonly orders?: typeof orders; readonly products?: (typeof product)[] }) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canEditOrders: true,
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: ROWS, productCount: 1, stockValueMinor: 0 },
    movements: [],
    orders: rows.orders?.map((order) => (order.id === 'order-1' ? { ...order, note: register.note } : order)) ?? [],
    products: rows.products ?? [],
    revision: register.revision,
    totalOrders: ROWS,
  });

/** Every records read the page sent, by what it asked for. */
const reads: string[] = [];
const commands: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const OwnerCatalogApi = ManageCatalogActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload: { view } }) =>
        Effect.sync(() => {
          if (view?.productIds !== undefined || view?.productId !== undefined) {
            reads.push('detail');
            return responseOf({ products: [product] });
          }
          if (view?.ordersLimit === 0) {
            reads.push('count');
            return responseOf({});
          }
          reads.push('list');
          return responseOf({ orders });
        }),
      ),
    ),
  ),
  serveApi(
    OwnerCatalogApi,
    HttpApiBuilder.group(OwnerCatalogApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          if (!Predicate.isTagged(payload.command, 'EditOrder') || payload.expectedRevision !== register.revision) {
            throw new Error('Fixture requires an edit against the current owner revision');
          }
          register.note = payload.command.note ?? '';
          register.revision += 1;
          return Schema.decodeSync(ApplyCommandResultSchema)({
            entityIds: [payload.command.id],
            revision: register.revision,
          });
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
);
const count = (kind: string) => reads.filter((read) => read === kind).length;

const OrdersList = () => {
  const { state } = useOrders(company.legalEntityId, firstOrdersPage(PAGE_SIZE), company);
  return createElement('output', null, state.kind);
};

let unmount: (() => void) | null = null;

const renderList = async (component: () => ReturnType<typeof createElement>) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  await act(async () => {
    root.render(createElement(component));
    await browserRuntime.runPromise(Effect.yieldNow);
  });
};

const mount = (component: () => ReturnType<typeof createElement>) =>
  Effect.gen(function* mountList() {
    yield* pinTestDocument;
    yield* Effect.promise(() => renderList(component));
    yield* waitUntilOnFakeTimers(() => text() === 'ready' || text().startsWith('ready:'));
  });

const closePage = () =>
  Effect.sync(() => {
    unmount?.();
    unmount = null;
  });

/** Lets fake time pass in one-second steps; the reads each timer starts are answered before the next step. */
const idle = (seconds: number): Effect.Effect<void> => passFakeTime(`${seconds} seconds`, { between: networkIdle });

/** The Shell's live channel reports a change committed elsewhere in `apps`. */
const liveChange = (apps: readonly string[]) =>
  Effect.sync(() => window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps } })));

/** Each warmed order detail reads its products' summaries and the first line's ledger. */
const DETAIL_READS = 2;
/** Opening warms the first rows only (10 rows on the page, 5 warmed). */
const WARMED = Math.min(ROWS, LIST_WARM_ROWS);

beforeEach(() => {
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  orderDetailData.invalidate();
  customerDirectoryData.invalidate();
  register.revision = 7;
  register.note = '';
  commands.length = 0;
  reads.length = 0;
});

afterEach(() => {
  unmount?.();
  unmount = null;
  rstest.useRealTimers();
});

it.live('an idle orders list reloads its page every 20 s and warms its rows once', () =>
  Effect.gen(function* idleList() {
    yield* mount(OrdersList);
    yield* idle(5);
    expect([count('list'), count('detail')]).toEqual([1, WARMED * DETAIL_READS]);
    reads.length = 0;

    yield* idle(60);
    // A minute: the page and the counts on each expiry of the freshness window, the unchanged rows not again.
    expect(count('list')).toBeGreaterThanOrEqual(2);
    expect(count('list')).toBeLessThanOrEqual(3);
    expect(count('detail')).toBe(0);
  }).pipe(Effect.provide(network)),
);

it.live('an opened orders list warms its rows only once the browser is idle', () =>
  Effect.gen(function* warmWhenIdle() {
    yield* mount(OrdersList);
    yield* networkIdle;
    expect([count('list'), count('detail')]).toEqual([1, 0]);
    yield* idle(1);
    expect(count('detail')).toBe(WARMED * DETAIL_READS);
  }).pipe(Effect.provide(network)),
);

it.live('an orders list unmounted before the browser is idle sends no detail read', () =>
  Effect.gen(function* leaveBeforeIdle() {
    yield* mount(OrdersList);
    yield* closePage();
    yield* idle(5);
    expect(count('detail')).toBe(0);
  }).pipe(Effect.provide(network)),
);

it.live('merchandise live changes reload the page, not the details of its unchanged rows', () =>
  Effect.gen(function* liveList() {
    yield* mount(OrdersList);
    yield* idle(5);
    reads.length = 0;

    for (let event = 0; event < 5; event += 1) {
      yield* liveChange(['merchandise']);
      yield* idle(2);
    }
    expect(count('list')).toBe(5);
    expect(count('detail')).toBe(0);
  }).pipe(Effect.provide(network)),
);

it.live('live changes of modules the orders do not show read nothing', () =>
  Effect.gen(function* unrelatedChanges() {
    yield* mount(OrdersList);
    yield* idle(5);
    reads.length = 0;

    for (let event = 0; event < 5; event += 1) {
      yield* liveChange(['finance-billing', 'shell', 'work-tasks']);
      yield* idle(2);
    }
    expect(reads).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('a write that moves the revision reloads the page and warms its rows again', () =>
  Effect.gen(function* afterWrite() {
    yield* mount(OrdersList);
    yield* idle(5);
    reads.length = 0;

    const scope = pageDataScopeKey(company, 'demo.merchandise');
    if (scope === undefined) {
      throw new Error('Fixture requires the complete company scope');
    }
    const source = { legalEntityId: company.legalEntityId, query: firstOrdersPage(PAGE_SIZE), scope };
    const orderId = Schema.decodeSync(OrderIdSchema)('order-1');
    const previousDetail = { orderId, revision: 7, scope, source };
    expect(orderDetailData.snapshot(previousDetail).state).toBe('ready');
    yield* editOrder({ _tag: 'EditOrder', id: orderId, note: 'Edited through the owner' }, 7);
    expect(commands).toEqual([
      {
        command: { _tag: 'EditOrder', id: 'order-1', note: 'Edited through the owner' },
        expectedRevision: 7,
      },
    ]);
    // A new list revision would create new detail keys even if the old detail cache were not invalidated.
    // Check the old entry too, so removing either production invalidation breaks this case.
    expect(orderDetailData.snapshot(previousDetail).state).toBe('pending');
    yield* idle(5);
    expect([count('list'), count('detail')]).toEqual([1, WARMED * DETAIL_READS]);
    expect(ordersPageData.snapshot(source)).toMatchObject({
      state: 'ready',
      value: {
        orders: expect.arrayContaining([expect.objectContaining({ id: 'order-1', note: 'Edited through the owner' })]),
        revision: 8,
      },
    });
  }).pipe(Effect.provide(network)),
);

it.live('pointing at a row whose warmed detail expired reads that detail once', () =>
  Effect.gen(function* intent() {
    yield* mount(OrdersList);
    yield* idle(25);
    reads.length = 0;
    const input: OrdersPageInput = {
      legalEntityId: company.legalEntityId,
      query: firstOrdersPage(PAGE_SIZE),
      scope: pageDataScopeKey(company, 'demo.merchandise'),
    };
    const page = ordersPageData.snapshot(input);
    const records = page.state === 'ready' ? page.value : undefined;
    expect(records).toBeDefined();
    const row = document.createElement('tr');
    row.dataset.index = '3';
    const props = orderDetailIntent(input, records, records?.orders ?? []);
    props.onPointerEnter({ currentTarget: row });
    props.onFocus({ currentTarget: row });
    yield* idle(1);
    expect(count('detail')).toBe(DETAIL_READS);
    // A fresh entry answers the next intent without a request.
    props.onPointerDown({ currentTarget: row });
    yield* idle(1);
    expect(count('detail')).toBe(DETAIL_READS);
  }).pipe(Effect.provide(network)),
);

/** The list with one actual order detail mounted, as the page wires them. */
const OpenOrder = () => {
  const query = firstOrdersPage(PAGE_SIZE);
  const { state } = useOrders(company.legalEntityId, query, company);
  const detail = useOrderDetail('order-1', 0, company, {
    legalEntityId: company.legalEntityId,
    query,
    scope: pageDataScopeKey(company, 'demo.merchandise'),
  });
  return createElement('output', null, `${state.kind}:${detail.status}`);
};

const openOrderReadsPerBusyMinute = (change: Effect.Effect<void>) =>
  Effect.gen(function* busyOrder() {
    yield* mount(OpenOrder);
    yield* idle(5);
    reads.length = 0;
    yield* Effect.forEach(Array.from({ length: 30 }), () => change.pipe(Effect.andThen(idle(2))), { discard: true });
    return reads.length;
  });

it.live('an idle open order ignores other modules committing every 2 s', () =>
  Effect.gen(function* otherModulesBusy() {
    const perMinute = yield* openOrderReadsPerBusyMinute(liveChange(['finance-billing', 'party-registry', 'shell']));
    expect(perMinute).toBe(15);
  }).pipe(Effect.provide(network)),
);

it.live('a change event without an app list still reloads the open order every time (as before scoping)', () =>
  Effect.gen(function* unscopedBusy() {
    const perMinute = yield* openOrderReadsPerBusyMinute(
      Effect.sync(() => window.dispatchEvent(new Event(moduleChangeEvent))),
    );
    expect(perMinute).toBe(150);
  }).pipe(Effect.provide(network)),
);
