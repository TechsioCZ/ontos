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
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { OrderSchema, ProductRecordSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { customerDirectoryData } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import {
  firstOrdersPage,
  orderCountsData,
  orderDetailData,
  orderDetailIntent,
  ordersPageData,
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

const responseOf = (rows: { readonly orders?: typeof orders; readonly products?: (typeof product)[] }) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canEditOrders: false,
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: ROWS, productCount: 1, stockValueMinor: 0 },
    movements: [],
    orders: rows.orders ?? [],
    products: rows.products ?? [],
    revision: 7,
    totalOrders: ROWS,
  });

/** Every records read the page sent, by what it asked for. */
const reads: string[] = [];
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
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
    yield* waitUntilOnFakeTimers(() => text() === 'ready');
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
