// @rstest-environment happy-dom
// A warmed order opens at once. The real `useOrders` list (or the list warm-up itself) warms the rows, then the
// detail mounts the way the orders route mounts it: `page.tsx` (side panel, with the list as its source) or
// `order-detail-page.tsx` (full page, the default view, without a source). Only the records client is replaced.
import { moduleChangeEvent, moduleWriteEvent, pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LIST_WARM_ROWS } from '@app/admin-ui';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { OrderSchema, ProductRecordSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { executeChangeOrderStatus } from '../../src/api/change-order-status-action-client.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { customerDirectoryData } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import {
  changeOrderStatuses,
  firstOrdersPage,
  orderCountsData,
  orderDetailData,
  orderDetailIntent,
  ordersPageData,
  preloadOrderDetails,
  useOrderDetail,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import type { OrdersPageInput } from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

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

const register = { revision: 7, stock: 10 };
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
      return Effect.succeed(responseOf({ products: [{ ...product, stockOnHand: register.stock }] }));
    }
    if (view?.orderId !== undefined) {
      reads.push('order');
      return Effect.succeed(responseOf({ orders: orders.filter((order) => order.id === view.orderId) }));
    }
    if (view?.ordersLimit === 0) {
      reads.push('count');
      return Effect.succeed(responseOf({}));
    }
    reads.push('list');
    return Effect.succeed(responseOf({ orders: orders.slice(0, view?.ordersLimit ?? ROWS) }));
  });
};
const count = (kind: string) => reads.filter((read) => read === kind).length;

/** The detail status on every render, in order. */
const statuses: string[] = [];
/** The stock of the line product each ready render showed: tells a reused copy from a fresh read. */
const shownStock: (number | undefined)[] = [];

const listInput: OrdersPageInput = {
  legalEntityId: company.legalEntityId,
  query: firstOrdersPage(PAGE_SIZE),
  scope: pageDataScopeKey(company, 'demo.merchandise'),
};

const OrdersList = () => {
  const { state } = useOrders(company.legalEntityId, firstOrdersPage(PAGE_SIZE), company);
  return createElement('output', null, state.kind);
};

/** The side panel of `page.tsx`: `useOrderDetail` over the list source of the same request. */
const panelFor = (orderId: string) => {
  const OrderPanel = () => {
    const detail = useOrderDetail(orderId, 0, company, {
      legalEntityId: company.legalEntityId,
      query: firstOrdersPage(PAGE_SIZE),
      scope: pageDataScopeKey(company, 'demo.merchandise'),
    });
    statuses.push(detail.status);
    if (detail.status === 'ready') {
      shownStock.push(detail.products[0]?.stockOnHand);
    }
    return createElement('output', null, detail.status);
  };
  return OrderPanel;
};

/** The full order page of `order-detail-page.tsx`: its own one-row list and `useOrderDetail` without a source. */
const fullPageFor = (orderId: string) => {
  const OrderPage = () => {
    useOrders(company.legalEntityId, firstOrdersPage(1), company);
    const detail = useOrderDetail(orderId, 0, company);
    statuses.push(detail.status);
    if (detail.status === 'ready') {
      shownStock.push(detail.products[0]?.stockOnHand);
    }
    return createElement('output', null, detail.status);
  };
  return OrderPage;
};

const unmounts: (() => void)[] = [];

const mountRoot = (component: () => ReturnType<typeof createElement>) =>
  Effect.promise(async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmounts.push(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
    });
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

/** The list warm-up without a mounted list: the first page, then its first rows' details. */
const warmWithoutList = Effect.gen(function* warmWithoutList() {
  yield* ordersPageData.preload(listInput);
  const page = ordersPageData.snapshot(listInput);
  if (page.state === 'ready') {
    yield* preloadOrderDetails(listInput, page.value);
  }
});

const dispatch = (event: Event) =>
  Effect.promise(() =>
    act(async () => {
      globalThis.dispatchEvent(event);
      await browserRuntime.runPromise(Effect.yieldNow);
    }),
  );

const WARMED = Math.min(ROWS, LIST_WARM_ROWS);
const DETAIL_READS = 2;

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  rstest.resetAllMocks();
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  orderDetailData.invalidate();
  customerDirectoryData.invalidate();
  register.revision = 7;
  register.stock = 10;
  shownStock.length = 0;
  reads.length = 0;
  statuses.length = 0;
  serve();
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
  rstest.useRealTimers();
  rstest.unstubAllGlobals();
});

it.effect('a row warmed by the list opens its panel at once: ready on the first render, no read', () =>
  Effect.gen(function* warmedOpen() {
    yield* mountRoot(OrdersList);
    yield* idle(5);
    expect(count('detail')).toBe(WARMED * DETAIL_READS);
    reads.length = 0;

    yield* mountRoot(panelFor('order-1'));
    yield* idle(2);
    expect(statuses[0]).toBe('ready');
    expect(statuses).not.toContain('loading');
    expect(reads).toEqual([]);
  }),
);

it.effect('a row warmed by the list opens on the full order page at once: ready on the first render, no read', () =>
  Effect.gen(function* warmedFullPage() {
    yield* mountRoot(OrdersList);
    yield* idle(5);
    reads.length = 0;

    yield* mountRoot(fullPageFor('order-1'));
    yield* idle(2);
    expect(statuses[0]).toBe('ready');
    expect(statuses).not.toContain('loading');
    expect(count('detail')).toBe(0);
    expect(count('order')).toBe(0);
  }),
);

it.effect('a row warmed by pointer intent opens its panel at once: ready on the first render, no read', () =>
  Effect.gen(function* intentOpen() {
    yield* mountRoot(OrdersList);
    yield* idle(5);
    reads.length = 0;
    const page = ordersPageData.snapshot(listInput);
    const records = page.state === 'ready' ? page.value : undefined;
    const row = document.createElement('tr');
    row.dataset.index = String(LIST_WARM_ROWS);
    const props = orderDetailIntent(listInput, records, records?.orders ?? []);
    props.onPointerEnter({ currentTarget: row });
    props.onFocus({ currentTarget: row });
    yield* idle(1);
    expect(count('detail')).toBe(DETAIL_READS);
    reads.length = 0;

    yield* mountRoot(panelFor(`order-${LIST_WARM_ROWS + 1}`));
    yield* idle(2);
    expect(statuses[0]).toBe('ready');
    expect(statuses).not.toContain('loading');
    expect(reads).toEqual([]);
  }),
);

it.effect(
  'a row warmed by pointer intent opens on the full order page at once: ready on the first render, no read',
  () =>
    Effect.gen(function* intentFullPage() {
      yield* mountRoot(OrdersList);
      yield* idle(5);
      reads.length = 0;
      const page = ordersPageData.snapshot(listInput);
      const records = page.state === 'ready' ? page.value : undefined;
      const row = document.createElement('tr');
      row.dataset.index = String(LIST_WARM_ROWS);
      const props = orderDetailIntent(listInput, records, records?.orders ?? []);
      props.onPointerEnter({ currentTarget: row });
      props.onFocus({ currentTarget: row });
      yield* idle(1);
      expect(count('detail')).toBe(DETAIL_READS);
      reads.length = 0;

      yield* mountRoot(fullPageFor(`order-${LIST_WARM_ROWS + 1}`));
      yield* idle(2);
      expect(statuses[0]).toBe('ready');
      expect(statuses).not.toContain('loading');
      expect(count('detail')).toBe(0);
      expect(count('order')).toBe(0);
    }),
);

it.effect('a warmed row older than the freshness window opens at once and is read again in the background', () =>
  Effect.gen(function* agedOpen() {
    yield* mountRoot(OrdersList);
    yield* idle(5);
    yield* idle(25);
    reads.length = 0;

    yield* mountRoot(panelFor('order-1'));
    expect(statuses[0]).toBe('ready');
    yield* idle(2);
    expect(statuses).not.toContain('loading');
    // The aged copy is refreshed once, as the open panel refreshes its order after the freshness window.
    expect(count('detail')).toBe(DETAIL_READS);
    expect(statuses.at(-1)).toBe('ready');
  }),
);

it.effect('an order nobody warmed still shows loading and reads its detail once', () =>
  Effect.gen(function* coldOpen() {
    yield* mountRoot(OrdersList);
    yield* idle(5);
    reads.length = 0;

    yield* mountRoot(panelFor(`order-${LIST_WARM_ROWS + 1}`));
    expect(statuses[0]).toBe('loading');
    yield* idle(2);
    expect(count('detail')).toBe(DETAIL_READS);
    expect(statuses.at(-1)).toBe('ready');
  }),
);

it.effect('an own write drops the warmed copy: the full page never shows it and reads the order again', () =>
  Effect.gen(function* writeOpen() {
    yield* mountRoot(OrdersList);
    yield* idle(5);
    yield* idle(25);
    const commit = yield* Schema.decodeEffect(ApplyCommandResultSchema)({ entityIds: ['order-1'], revision: 8 });
    rstest.mocked(executeChangeOrderStatus).mockReturnValueOnce(Effect.succeed(commit));
    register.revision = 8;
    register.stock = 9;
    reads.length = 0;
    yield* changeOrderStatuses({
      orders: orders.slice(0, 1).map((order) => Schema.decodeSync(OrderSchema)(order)),
      revision: 7,
      status: 'CONFIRMED',
    });

    yield* mountRoot(fullPageFor('order-1'));
    yield* idle(2);
    expect(count('detail')).toBeGreaterThanOrEqual(DETAIL_READS);
    expect(shownStock).not.toContain(10);
    expect(shownStock.at(-1)).toBe(9);
  }),
);

it.effect('a write settled elsewhere drops the warmed copy: the panel never shows it and reads the order again', () =>
  Effect.gen(function* settledWriteOpen() {
    yield* mountRoot(OrdersList);
    yield* idle(5);
    yield* idle(25);
    register.stock = 9;
    reads.length = 0;
    yield* dispatch(new Event(moduleWriteEvent));

    yield* mountRoot(panelFor('order-1'));
    expect(statuses[0]).toBe('loading');
    yield* idle(2);
    expect(count('detail')).toBe(DETAIL_READS);
    expect(shownStock).not.toContain(10);
    expect(shownStock.at(-1)).toBe(9);
  }),
);

it.effect('a live change of the orders drops the warmed copy, also a fresh one', () =>
  Effect.gen(function* liveChangeOpen() {
    yield* mountRoot(OrdersList);
    yield* idle(5);
    yield* dispatch(new CustomEvent(moduleChangeEvent, { detail: { apps: ['merchandise'] } }));
    yield* idle(1);
    reads.length = 0;

    register.stock = 9;
    yield* mountRoot(panelFor('order-1'));
    expect(statuses[0]).toBe('loading');
    yield* idle(2);
    expect(count('detail')).toBe(DETAIL_READS);
    expect(shownStock).not.toContain(10);
    expect(shownStock.at(-1)).toBe(9);
  }),
);

it.effect('a live change of another module keeps the warmed copy', () =>
  Effect.gen(function* unrelatedChangeOpen() {
    yield* warmWithoutList;
    yield* idle(25);
    yield* dispatch(new CustomEvent(moduleChangeEvent, { detail: { apps: ['party-registry'] } }));
    reads.length = 0;

    yield* mountRoot(fullPageFor('order-1'));
    expect(statuses[0]).toBe('ready');
    yield* idle(2);
    expect(statuses).not.toContain('loading');
  }),
);
