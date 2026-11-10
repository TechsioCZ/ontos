// @rstest-environment happy-dom
// The orders list across a reload: the real `useOrders` over the real strict stores, with only the generated records
// client replaced. A write, a live change and the freshness window all make the strict page read as pending, so
// without a held read the table drops to its loading rows and the page loses the write capability its buttons need.
import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  OrderSchema,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  ProductRecordSchema,
} from '../../shared/apis/records.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import {
  firstOrdersPage,
  orderCountsData,
  orderDetailData,
  ordersPageData,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import type { OrdersQuery, OrdersState } from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
rstest.mock('../../src/api/change-order-status-action-client.ts');

const company: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const otherTenant: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-2' };
const instant = '2026-10-15T10:00:00Z';
const PAGE_SIZE = 2;

const orderOf = (number: string) =>
  Schema.decodeSync(OrderSchema)({
    createdAt: instant,
    id: `order-${number}`,
    lines: [
      { productId: 'product-1', productName: 'Cable', quantity: 2, sku: 'CABLE', unitPriceMinor: 100, vatRate: 21 },
    ],
    number,
    partyId: 'party-1',
    status: 'NEW',
    totalMinor: 200,
    totalVatMinor: 42,
    updatedAt: instant,
  });
const product = Schema.decodeSync(ProductRecordSchema)({
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
const recordsOf = (numbers: readonly string[], revision: number, totalOrders: number) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 200, orderCount: 4, productCount: 1, stockValueMinor: 1000 },
    movements: [],
    orders: numbers.map((number) => Schema.encodeSync(OrderSchema)(orderOf(number))),
    products: [],
    revision,
    totalOrders,
  });
const denied = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});

interface Register {
  /** Number of shipped (and of cancelled) orders the header counts read. */
  readonly counted: number;
  /** Order numbers per page offset. */
  readonly pages: Readonly<Record<number, readonly string[]>>;
  readonly revision: number;
}

/** The register behind the mocked client; with a gate, every read waits until the gate opens. */
const serve = (register: Register, gate?: Deferred.Deferred<boolean>) => {
  rstest.mocked(executeRecords).mockImplementation(({ view }) => {
    const page = recordsOf(register.pages[view?.ordersOffset ?? 0] ?? [], register.revision, register.counted);
    const lineProducts = view?.productId !== undefined || view?.productIds !== undefined;
    const answer = lineProducts ? { ...page, orders: [], products: [product] } : page;
    return gate === undefined ? Effect.succeed(answer) : Deferred.await(gate).pipe(Effect.as(answer));
  });
};

/** Every read is refused from now on. */
const refuse = () => {
  rstest.mocked(executeRecords).mockReturnValue(Effect.fail(denied));
};

/** What the table showed on every render, and how often its rows mounted. */
const shown: string[] = [];
let mounts = 0;

/** What the orders page makes of the hook: rows only for the request on screen, otherwise the loading rows. */
const tableOf = (state: OrdersState, query: OrdersQuery): string => {
  if (state.kind !== 'ready') {
    return state.kind;
  }
  if (state.query !== query) {
    return 'loading';
  }
  const numbers = state.records.orders.map((order) => order.number).join(',');
  const write = state.records.canWrite ? 'write' : 'read-only';
  return `rows:${numbers}|${write}|shipped:${state.counts?.shipped ?? '—'}`;
};

/** Stands for the table body with its rows: it exists only while the rows are on screen. */
const Rows = ({ text }: { readonly text: string }) => {
  useEffect(() => {
    mounts += 1;
  }, []);
  return createElement('output', null, text);
};

const OrdersTable = ({ context, offset }: { readonly context: ModulePageContext; readonly offset: number }) => {
  // The page builds the request on every render, as here.
  const query: OrdersQuery = { ...firstOrdersPage(PAGE_SIZE), offset };
  const { state } = useOrders(context.legalEntityId, query, context);
  const table = tableOf(state, query);
  shown.push(table);
  return table.startsWith('rows:') ? createElement(Rows, { text: table }) : null;
};

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

interface Mounted {
  readonly show: (context: ModulePageContext, offset: number) => Effect.Effect<void>;
}

let unmount: (() => void) | null = null;

const mount = (context: ModulePageContext, offset: number): Effect.Effect<Mounted> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => {
      root.unmount();
      container.remove();
    });
  };
  const show = (nextContext: ModulePageContext, nextOffset: number) =>
    Effect.promise(() =>
      act(async () => {
        root.render(createElement(OrdersTable, { context: nextContext, offset: nextOffset }));
        await settle();
      }),
    );
  return show(context, offset).pipe(Effect.as({ show }));
};

/** An order command settled, or a live change arrived: the strict stores drop what they have and read again. */
const invalidate = Effect.promise(async () => {
  await act(async () => {
    ordersPageData.invalidate();
    orderCountsData.invalidate();
    orderDetailData.invalidate();
    await settle();
  });
  await act(settle);
});

const before = 'rows:ORD-1,ORD-2|write|shipped:3';

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  orderDetailData.invalidate();
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  shown.length = 0;
  mounts = 0;
});

afterEach(() => {
  unmount?.();
  unmount = null;
  rstest.unstubAllGlobals();
});

it.effect('the rows, the write capability and the header counts stay on screen while the same page reloads', () =>
  Effect.gen(function* held() {
    serve({ counted: 3, pages: { 0: ['ORD-1', 'ORD-2'] }, revision: 7 });
    yield* mount(company, 0);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === before));
    expect(mounts).toBe(1);

    const gate = yield* Deferred.make<boolean>();
    serve({ counted: 4, pages: { 0: ['ORD-3', 'ORD-1'] }, revision: 8 }, gate);
    shown.length = 0;
    yield* invalidate;
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown)).toEqual(new Set([before]));

    yield* Deferred.succeed(gate, true);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'rows:ORD-3,ORD-1|write|shipped:4'));
    expect(shown.filter((table) => !table.startsWith('rows:'))).toEqual([]);
    expect(mounts).toBe(1);
  }),
);

it.effect('another page never shows the rows of the page before it', () =>
  Effect.gen(function* otherPage() {
    serve({ counted: 3, pages: { 0: ['ORD-1', 'ORD-2'], 2: ['ORD-3', 'ORD-4'] }, revision: 7 });
    const view = yield* mount(company, 0);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === before));

    const gate = yield* Deferred.make<boolean>();
    serve({ counted: 3, pages: { 0: ['ORD-1', 'ORD-2'], 2: ['ORD-3', 'ORD-4'] }, revision: 7 }, gate);
    shown.length = 0;
    yield* view.show(company, 2);
    yield* Effect.promise(() => act(settle));
    expect(new Set(shown)).toEqual(new Set(['loading']));

    yield* Deferred.succeed(gate, true);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'rows:ORD-3,ORD-4|write|shipped:3'));
    expect(shown.filter((table) => table.startsWith('rows:ORD-1'))).toEqual([]);
  }),
);

it.effect('the page held through a write is not shown for another page', () =>
  Effect.gen(function* otherPageAfterWrite() {
    serve({ counted: 3, pages: { 0: ['ORD-1', 'ORD-2'], 2: ['ORD-3', 'ORD-4'] }, revision: 7 });
    const view = yield* mount(company, 0);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === before));

    // A write reloads the first page; while it is on its way the person moves to the second page.
    const gate = yield* Deferred.make<boolean>();
    serve({ counted: 3, pages: { 0: ['ORD-5', 'ORD-1'], 2: ['ORD-2', 'ORD-3'] }, revision: 8 }, gate);
    yield* invalidate;
    shown.length = 0;
    yield* view.show(company, 2);
    yield* Effect.promise(() => act(settle));
    expect(new Set(shown)).toEqual(new Set(['loading']));

    yield* Deferred.succeed(gate, true);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'rows:ORD-2,ORD-3|write|shipped:3'));
    expect(shown.filter((table) => table.startsWith('rows:ORD-1'))).toEqual([]);
  }),
);

it.effect('another tenant never shows the rows of the tenant before it', () =>
  Effect.gen(function* otherTenantRows() {
    serve({ counted: 3, pages: { 0: ['ORD-1', 'ORD-2'] }, revision: 7 });
    const view = yield* mount(company, 0);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === before));
    expect(pageDataScopeKey(otherTenant, 'demo.merchandise')).not.toBe(pageDataScopeKey(company, 'demo.merchandise'));

    const gate = yield* Deferred.make<boolean>();
    serve({ counted: 1, pages: { 0: ['ORD-9'] }, revision: 2 }, gate);
    shown.length = 0;
    yield* view.show(otherTenant, 0);
    yield* Effect.promise(() => act(settle));
    expect(new Set(shown)).toEqual(new Set(['loading']));

    yield* Deferred.succeed(gate, true);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'rows:ORD-9|write|shipped:1'));
    expect(shown.filter((table) => table.startsWith('rows:ORD-1'))).toEqual([]);
  }),
);

it.effect('a refused reload takes the held rows away at once', () =>
  Effect.gen(function* refused() {
    serve({ counted: 3, pages: { 0: ['ORD-1', 'ORD-2'] }, revision: 7 });
    yield* mount(company, 0);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === before));

    refuse();
    yield* invalidate;
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'forbidden'));
    expect(mounts).toBe(1);
  }),
);
