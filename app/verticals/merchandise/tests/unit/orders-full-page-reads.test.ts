// @rstest-environment happy-dom
// Full-page order hooks run against the real stores, gateway issuer and owner HTTP contracts, on fake timers: the
// 20 s freshness window and the idle warm-up run on a controlled clock.
import {
  passFakeTime,
  settleOnFakeTimers,
  text,
  unmountAll,
  waitUntilOnFakeTimers,
} from '@app/admin-ui/testing/module-ui';
import { partyRegistryApi } from '@app/party-registry/api';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { OrderSchema, ProductRecordSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { customerDirectoryData } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import {
  firstOrdersPage,
  orderCountsData,
  orderDetailData,
  ordersPageData,
  preloadOrdersPage,
  useOrderDetail,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { mountInRoute } from '../support/module-ui.ts';

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
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const CustomersApi = HttpApi.make('CustomerListApi')
  .add(partyRegistryApi.groups.customerList)
  .prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api', 'party-registry': '/party-registry-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload: { view } }) =>
        Effect.sync(() => {
          if (view?.productIds !== undefined || view?.productId !== undefined) {
            reads.push('detail');
            return responseOf({ products: [product] });
          }
          if (view?.orderId !== undefined) {
            reads.push('order');
            return responseOf({ orders: orders.filter((order) => order.id === view.orderId) });
          }
          if (view?.ordersLimit === 0) {
            reads.push('count');
            return responseOf({});
          }
          reads.push(`list-${view?.ordersLimit ?? 0}`);
          return responseOf({ orders });
        }),
      ),
    ),
  ),
  serveApi(
    CustomersApi,
    HttpApiBuilder.group(CustomersApi, 'customerList', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
);
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

const mount = (component: () => ReturnType<typeof createElement>) =>
  mountInRoute(createElement(component), {
    path: '/prodej/objednavky',
    settle: settleOnFakeTimers,
    url: '/cs/prodej/objednavky',
  });

const closePage = () => Effect.sync(unmountAll);

/** Lets fake time pass in one-second steps; the reads each timer starts are answered before the next step. */
const idle = (seconds: number): Effect.Effect<void> => passFakeTime(`${seconds} seconds`, { between: networkIdle });

const liveChange = (apps: readonly string[]) =>
  Effect.sync(() => window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps } })));

beforeEach(() => {
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  orderDetailData.invalidate();
  customerDirectoryData.invalidate();
  register.revision = 7;
  reads.length = 0;
});

afterEach(() => {
  unmountAll();
  rstest.useRealTimers();
});

it.live(
  'opening a warmed order on the full page warms no other order and reads only its own refreshes for a minute',
  () =>
    Effect.gen(function* warmedOpen() {
      yield* pinTestDocument;
      yield* mount(OrdersList);
      yield* idle(1);
      expect(count('detail')).toBe(10);
      yield* closePage();
      reads.length = 0;

      yield* mount(FullOrderPage);
      yield* networkIdle;
      yield* waitUntilOnFakeTimers(() => text().includes('ready:true:ready'));
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
    }).pipe(Effect.provide(network)),
);

it.live('a list mounted after the preload of its first page reads neither the page nor the counts again', () =>
  Effect.gen(function* preloaded() {
    yield* pinTestDocument;
    yield* Effect.promise(() =>
      browserRuntime.runPromise(preloadOrdersPage(company.legalEntityId, PAGE_SIZE, company)),
    );
    expect(count('list-50')).toBe(1);
    expect(count('count')).toBe(2);
    reads.length = 0;

    yield* mount(OrdersList);
    yield* idle(1);
    expect(count('list-50')).toBe(0);
    expect(count('count')).toBe(0);
  }).pipe(Effect.provide(network)),
);

it.live('a direct URL open loads the order once and shows the permissions', () =>
  Effect.gen(function* directOpen() {
    yield* pinTestDocument;
    yield* mount(FullOrderPage);
    yield* idle(1);
    expect(count('list-1')).toBe(1);
    expect(count('order')).toBe(1);
    expect(count('detail')).toBe(2);
    expect(count('list-50')).toBe(0);
  }).pipe(Effect.provide(network)),
);

it.live('a live change of merchandise reloads the open order on the full page', () =>
  Effect.gen(function* liveRefresh() {
    yield* pinTestDocument;
    yield* mount(FullOrderPage);
    yield* idle(1);
    reads.length = 0;
    yield* liveChange(['merchandise']);
    yield* idle(2);
    expect(count('order')).toBeGreaterThanOrEqual(1);
    expect(count('list-50')).toBe(0);
  }).pipe(Effect.provide(network)),
);
