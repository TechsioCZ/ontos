// @rstest-environment happy-dom
// The orders list across a reload: the real `useOrders`, strict stores and generated records client
// over the real HTTP contract served in process. A write, a live change and the freshness window all make the strict page read as pending, so
// without a held read the table drops to its loading rows and the page loses the write capability its buttons need.
import { acted, settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  OrderSchema,
  RecordsApi,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  ProductRecordSchema,
} from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import {
  firstOrdersPage,
  forgetRememberedOrders,
  orderCountsData,
  orderDetailData,
  ordersPageData,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import type { OrdersQuery, OrdersState } from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';

const company: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const otherTenant: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-2' };
const instant = '2026-10-15T10:00:00Z';
const PAGE_SIZE = 2;

const orderOf = (number: string) =>
  Schema.decodeSync(OrderSchema)({
    createdAt: instant,
    id: `order-${number}`,
    lines: [
      {
        productId: 'product-1',
        productName: 'Cable',
        quantity: 2,
        sku: 'CABLE',
        taxClassificationCode: 'cz.vat.standard',
        taxRuleRevisionId: 'tax-rule-revision-standard-21',
        unitPriceMinor: 100,
        vatRate: 21,
      },
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
  taxClassificationCode: 'cz.vat.standard',
  unit: 'ks',
  updatedAt: instant,
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
    taxRates: [],
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

let answer: (payload: RecordsRequest) => Effect.Effect<RecordsResponse, typeof denied> = (_payload: RecordsRequest) =>
  Effect.never;

const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) => Effect.suspend(() => answer(payload))),
    ),
  ),
);

/** The register behind the real endpoint; with a gate, every read waits until the gate opens. */
const serve = (register: Register, gate?: Deferred.Deferred<boolean>) => {
  answer = ({ view }) => {
    const page = recordsOf(register.pages[view?.ordersOffset ?? 0] ?? [], register.revision, register.counted);
    const lineProducts = view?.productId !== undefined || view?.productIds !== undefined;
    const response = lineProducts ? { ...page, orders: [], products: [product] } : page;
    return gate === undefined ? Effect.succeed(response) : Deferred.await(gate).pipe(Effect.as(response));
  };
};

/** Every read is refused from now on. */
const refuse = () => {
  answer = () => Effect.fail(denied);
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
    acted(() => {
      root.render(createElement(OrdersTable, { context: nextContext, offset: nextOffset }));
    });
  return show(context, offset).pipe(Effect.as({ show }));
};

/** An order command settled, or a live change arrived: the strict stores drop what they have and read again. */
const invalidate = acted(() => {
  forgetRememberedOrders();
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  orderDetailData.invalidate();
}).pipe(Effect.andThen(settle));

const before = 'rows:ORD-1,ORD-2|write|shipped:3';

beforeEach(() => {
  forgetRememberedOrders();
  orderDetailData.invalidate();
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  shown.length = 0;
  mounts = 0;
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

it.live('the rows, the write capability and the header counts stay on screen while the same page reloads', () =>
  Effect.gen(function* held() {
    yield* pinTestDocument;
    serve({ counted: 3, pages: { 0: ['ORD-1', 'ORD-2'] }, revision: 7 });
    yield* mount(company, 0);
    yield* waitUntil(() => shown.at(-1) === before);
    expect(mounts).toBe(1);

    const gate = yield* Deferred.make<boolean>();
    serve({ counted: 4, pages: { 0: ['ORD-3', 'ORD-1'] }, revision: 8 }, gate);
    shown.length = 0;
    yield* invalidate;
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown)).toEqual(new Set([before]));

    yield* Deferred.succeed(gate, true);
    yield* waitUntil(() => shown.at(-1) === 'rows:ORD-3,ORD-1|write|shipped:4');
    expect(shown.filter((table) => !table.startsWith('rows:'))).toEqual([]);
    expect(mounts).toBe(1);
  }).pipe(Effect.provide(network)),
);

it.live('another tenant never shows the rows of the tenant before it', () =>
  Effect.gen(function* otherTenantRows() {
    yield* pinTestDocument;
    serve({ counted: 3, pages: { 0: ['ORD-1', 'ORD-2'] }, revision: 7 });
    const view = yield* mount(company, 0);
    yield* waitUntil(() => shown.at(-1) === before);
    expect(pageDataScopeKey(otherTenant, 'demo.merchandise')).not.toBe(pageDataScopeKey(company, 'demo.merchandise'));

    const gate = yield* Deferred.make<boolean>();
    serve({ counted: 1, pages: { 0: ['ORD-9'] }, revision: 2 }, gate);
    shown.length = 0;
    yield* view.show(otherTenant, 0);
    yield* settle;
    expect(new Set(shown)).toEqual(new Set(['loading']));

    yield* Deferred.succeed(gate, true);
    yield* waitUntil(() => shown.at(-1) === 'rows:ORD-9|write|shipped:1');
    expect(shown.filter((table) => table.startsWith('rows:ORD-1'))).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('a refused reload takes the held rows away at once', () =>
  Effect.gen(function* refused() {
    yield* pinTestDocument;
    serve({ counted: 3, pages: { 0: ['ORD-1', 'ORD-2'] }, revision: 7 });
    yield* mount(company, 0);
    yield* waitUntil(() => shown.at(-1) === before);

    refuse();
    yield* invalidate;
    yield* waitUntil(() => shown.at(-1) === 'forbidden');
    expect(mounts).toBe(1);
  }).pipe(Effect.provide(network)),
);
