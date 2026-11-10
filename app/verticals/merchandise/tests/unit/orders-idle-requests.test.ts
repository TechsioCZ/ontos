// @rstest-environment happy-dom
// How many records reads an idle orders list sends: the real `useOrders` hook over the real strict stores, with only
// the generated records client replaced and the clock faked. The list reloads its page after the 20 s freshness
// window, after a live change of merchandise and after a write. The details warmed for its rows are read once per list
// revision, not again whenever the page reload settles, and live changes of unrelated modules read nothing.
import { moduleChangeEvent, pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { OrderSchema, ProductRecordSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { customerDirectoryData } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import {
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

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
rstest.mock('../../src/api/change-order-status-action-client.ts');

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

/** The owner revision the register answers with; a write moves it. */
const register = { revision: 7 };
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
    revision: register.revision,
    totalOrders: ROWS,
  });

/** Every records read the page sent, by what it asked for. */
const reads: string[] = [];
const serve = () => {
  rstest.mocked(executeRecords).mockImplementation(({ view }) => {
    if (view?.productIds !== undefined || view?.productId !== undefined) {
      reads.push('detail');
      return Effect.succeed(responseOf({ products: [product] }));
    }
    if (view?.ordersLimit === 0) {
      reads.push('count');
      return Effect.succeed(responseOf({}));
    }
    reads.push('list');
    return Effect.succeed(responseOf({ orders }));
  });
};
const count = (kind: string) => reads.filter((read) => read === kind).length;

const OrdersList = () => {
  const { state } = useOrders(company.legalEntityId, firstOrdersPage(PAGE_SIZE), company);
  return createElement('output', null, state.kind);
};

let unmount: (() => void) | null = null;

const mount = (component: () => ReturnType<typeof createElement>) =>
  Effect.promise(async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => {
        root.unmount();
        container.remove();
      });
    };
    await act(async () => {
      root.render(createElement(component));
      await browserRuntime.runPromise(Effect.yieldNow);
    });
  });

/** Lets fake time pass in one-second steps, so every timer and every render it causes runs in between. */
const idle = (seconds: number): Effect.Effect<void> =>
  seconds <= 0
    ? Effect.void
    : Effect.promise(() =>
        act(async () => {
          await rstest.advanceTimersByTimeAsync(1000);
        }),
      ).pipe(Effect.andThen(Effect.suspend(() => idle(seconds - 1))));

/** The Shell's live channel reports a change committed elsewhere in `apps`. */
const liveChange = (apps: readonly string[]) =>
  Effect.sync(() => globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps } })));

/** Each warmed order detail reads its products' summaries and the first line's ledger. */
const DETAIL_READS = 2;
/** Opening warms the first rows only (10 rows on the page, 5 warmed). */
const WARMED = Math.min(ROWS, LIST_WARM_ROWS);

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  rstest.resetAllMocks();
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  orderDetailData.invalidate();
  customerDirectoryData.invalidate();
  register.revision = 7;
  reads.length = 0;
  serve();
});

afterEach(() => {
  unmount?.();
  unmount = null;
  rstest.useRealTimers();
  rstest.unstubAllGlobals();
});

it.effect('an idle orders list reloads its page every 20 s and warms its rows once', () =>
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
  }),
);

it.effect('merchandise live changes reload the page, not the details of its unchanged rows', () =>
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
  }),
);

it.effect('live changes of modules the orders do not show read nothing', () =>
  Effect.gen(function* unrelatedChanges() {
    yield* mount(OrdersList);
    yield* idle(5);
    reads.length = 0;

    for (let event = 0; event < 5; event += 1) {
      yield* liveChange(['finance-billing', 'shell', 'work-tasks']);
      yield* idle(2);
    }
    expect(reads).toEqual([]);
  }),
);

it.effect('a write that moves the revision reloads the page and warms its rows again', () =>
  Effect.gen(function* afterWrite() {
    yield* mount(OrdersList);
    yield* idle(5);
    reads.length = 0;

    register.revision = 8;
    yield* Effect.sync(() => {
      ordersPageData.invalidate();
      orderDetailData.invalidate();
    });
    yield* idle(5);
    expect([count('list'), count('detail')]).toEqual([1, WARMED * DETAIL_READS]);
  }),
);

it.effect('pointing at a row whose warmed detail expired reads that detail once', () =>
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
  }),
);

/** The orders page with one order's detail open, as `page.tsx` wires them. */
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

/** Reads of an idle open order while another module commits every 2 s for a minute, as on a busy stage tenant. */
const openOrderReadsPerBusyMinute = (change: Effect.Effect<void>) =>
  Effect.gen(function* busyOrder() {
    yield* mount(OpenOrder);
    yield* idle(5);
    reads.length = 0;
    yield* Effect.forEach(Array.from({ length: 30 }), () => change.pipe(Effect.andThen(idle(2))), { discard: true });
    return reads.length;
  });

it.effect('an idle open order ignores other modules committing every 2 s', () =>
  Effect.gen(function* otherModulesBusy() {
    const perMinute = yield* openOrderReadsPerBusyMinute(liveChange(['finance-billing', 'party-registry', 'shell']));
    expect(perMinute).toBe(15);
  }),
);

it.effect('a change event without an app list still reloads the open order every time (as before scoping)', () =>
  Effect.gen(function* unscopedBusy() {
    const perMinute = yield* openOrderReadsPerBusyMinute(
      Effect.sync(() => globalThis.dispatchEvent(new Event(moduleChangeEvent))),
    );
    expect(perMinute).toBe(150);
  }),
);
