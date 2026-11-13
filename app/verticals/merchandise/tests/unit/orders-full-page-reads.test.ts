// @rstest-environment happy-dom
// The records reads of the full order page: the one-row permissions list, and the open order's own refreshes. The
// hooks are the real `useOrders` and `useOrderDetail` over the real strict stores, wired as `OrderDetailPage` wires
// them, with only the generated records client replaced and the clock faked.
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
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
  ordersPageData,
  useOrderDetail,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
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
const OPENED = 'order-1';

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
          taxClassificationCode: 'cz.vat.standard',
          taxRuleRevisionId: 'tax-rule-revision-standard-21',
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
    taxClassificationCode: 'cz.vat.standard',
    unit: 'ks',
    updatedAt: instant,
  }),
);

/** The owner revision the register answers with. */
const register = { revision: 7 };
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
    orders: rows.orders ?? [],
    products: rows.products ?? [],
    revision: register.revision,
    taxRates: [],
    totalOrders: ROWS,
  });

/** Every records read, named by what it asked for: `list-<rows>`, `count`, `order` (by id), `detail`. */
const reads: string[] = [];
const serve = () => {
  rstest.mocked(executeRecords).mockImplementation(({ view }) => {
    if (view?.productIds !== undefined || view?.productId !== undefined) {
      reads.push('detail');
      return Effect.succeed(responseOf({ products: [product] }));
    }
    if (view?.orderId !== undefined) {
      reads.push('order');
      return Effect.succeed(responseOf({ orders: orders.filter((order) => order.id === view.orderId) }));
    }
    if (view?.ordersLimit === 0) {
      reads.push('count');
      return Effect.succeed(responseOf({}));
    }
    reads.push(`list-${view?.ordersLimit ?? 0}`);
    return Effect.succeed(responseOf({ orders }));
  });
};
const count = (kind: string) => reads.filter((read) => read === kind).length;

/** The orders list page as `page.tsx` mounts it: 50 rows, counts and the warm-up of its first rows. */
const OrdersList = () => {
  const { state } = useOrders(company.legalEntityId, firstOrdersPage(PAGE_SIZE), company);
  return createElement('output', null, state.kind);
};

/** The full order page as `OrderDetailPage` mounts its records: the one-row permissions list and the open order. */
const FullOrderPage = () => {
  const list = useOrders(company.legalEntityId, firstOrdersPage(1), company, { counts: false, warm: false });
  const permissions = list.state.kind === 'ready' ? list.state.records.canWrite : 'none';
  const detail = useOrderDetail(OPENED, 0, company);
  return createElement('output', null, `${list.state.kind}:${String(permissions)}:${detail.status}`);
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

const closePage = () =>
  Effect.sync(() => {
    unmount?.();
    unmount = null;
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

const liveChange = (apps: readonly string[]) =>
  Effect.sync(() => globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps } })));

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

it.effect(
  'opening a warmed order on the full page warms no other order and reads only its own refreshes for a minute',
  () =>
    Effect.gen(function* warmedOpen() {
      yield* mount(OrdersList);
      yield* idle(1);
      yield* closePage();
      reads.length = 0;

      yield* mount(FullOrderPage);
      // The opening reads the permissions row only: the opened order answers from its warm copy at once.
      expect(reads).toEqual(['list-1']);
      reads.length = 0;

      yield* idle(60);
      // The permissions row is read on each 20 s expiry; the open order refreshes by id with its products.
      expect(count('list-1')).toBe(3);
      expect(count('list-50')).toBe(0);
      expect(count('count')).toBe(0);
      expect(count('order')).toBe(3);
      expect(count('detail')).toBe(6);
      expect(reads.length).toBe(12);
    }),
);

it.effect('a background refresh of the open order on the full page does not read the 50-row list', () =>
  Effect.gen(function* refresh() {
    yield* mount(OrdersList);
    yield* idle(1);
    yield* closePage();
    yield* mount(FullOrderPage);
    reads.length = 0;

    yield* idle(25);
    expect(count('list-50')).toBe(0);
    expect(count('order')).toBeGreaterThanOrEqual(1);
  }),
);

it.effect('the orders list still warms its first rows', () =>
  Effect.gen(function* listWarms() {
    yield* mount(OrdersList);
    yield* idle(5);
    expect(count('list-50')).toBe(1);
    expect(count('detail')).toBe(Math.min(ROWS, LIST_WARM_ROWS) * 2);
  }),
);

it.effect('a direct URL open loads the order once and shows the permissions', () =>
  Effect.gen(function* directOpen() {
    yield* mount(FullOrderPage);
    yield* idle(1);
    expect(count('list-1')).toBe(1);
    expect(count('order')).toBe(1);
    expect(count('detail')).toBe(2);
    expect(count('list-50')).toBe(0);
  }),
);

it.effect('a live change of merchandise reloads the open order on the full page', () =>
  Effect.gen(function* liveRefresh() {
    yield* mount(FullOrderPage);
    yield* idle(1);
    reads.length = 0;
    yield* liveChange(['merchandise']);
    yield* idle(2);
    expect(count('order')).toBeGreaterThanOrEqual(1);
    expect(count('list-50')).toBe(0);
  }),
);
