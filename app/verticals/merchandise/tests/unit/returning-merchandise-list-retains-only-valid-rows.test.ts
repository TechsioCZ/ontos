// @rstest-environment happy-dom
import { text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { moduleChangeEvent, moduleWriteEvent } from '@app/shared-contracts/page-data';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import {
  firstOrdersPage,
  orderCountsData,
  orderDetailData,
  ordersPageData,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { firstProductPage, productListData } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { useProductPage } from '../../src/routes/[lang]/provoz/produkty/product-list-page.ts';
import { mountInRoute } from '../support/module-ui.ts';

const context = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const records = Schema.decodeSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  canManageCatalog: true,
  canWrite: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 1, productCount: 1, stockValueMinor: 100 },
  movements: [],
  orders: [
    {
      createdAt: instant,
      id: 'order-1',
      lines: [
        { productId: 'product-1', productName: 'Cable', quantity: 1, sku: 'CABLE', unitPriceMinor: 100, vatRate: 21 },
      ],
      number: 'ORD-1',
      partyId: 'party-1',
      status: 'NEW',
      totalMinor: 100,
      totalVatMinor: 21,
      updatedAt: instant,
    },
  ],
  products: [
    {
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
      stockOnHand: 1,
      stockValueMinor: 100,
      unit: 'ks',
      updatedAt: instant,
    },
  ],
  revision: 7,
  totalOrders: 1,
});
const reads: string[] = [];
const Api = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    Api,
    HttpApiBuilder.group(Api, 'records', (group) =>
      group.handle('execute', ({ payload: { view } }) =>
        Effect.sync(() => {
          if (view?.limit === 0) {
            reads.push(view.ordersLimit === 0 ? 'counts' : 'orders');
          } else {
            reads.push('products');
          }
          return records;
        }),
      ),
    ),
  ),
);
const phases: string[] = [];
const Orders = () => {
  const { state } = useOrders(context.legalEntityId, firstOrdersPage(50), context, { warm: false });
  phases.push(state.kind);
  return createElement(
    'output',
    null,
    state.kind === 'ready' ? state.records.orders.map((row) => row.number).join(',') : state.kind,
  );
};
const Products = () => {
  const { state } = useProductPage(context.legalEntityId, firstProductPage(50), context);
  phases.push(state.status);
  return createElement(
    'output',
    null,
    state.status === 'ready' ? state.response.products.map((row) => row.name).join(',') : state.status,
  );
};
const idle = (seconds: number) => Effect.sleep(`${seconds} seconds`).pipe(Effect.andThen(networkIdle));
const returnToList = (kind: 'orders' | 'products', event?: Event) =>
  Effect.gen(function* reopenList() {
    yield* pinTestDocument;
    const mount = () => mountInRoute(createElement(kind === 'orders' ? Orders : Products));
    yield* mount();
    yield* networkIdle;
    yield* waitUntil(() => text() === (kind === 'orders' ? 'ORD-1' : 'Cable'));
    expect(text()).toBe(kind === 'orders' ? 'ORD-1' : 'Cable');
    unmountAll();
    yield* networkIdle;
    yield* idle(30);
    if (event !== undefined) {
      window.dispatchEvent(event);
    }
    reads.length = 0;
    phases.length = 0;
    yield* mount();
    expect(phases[0]).toBe(event === undefined ? 'ready' : 'loading');
    if (event === undefined) {
      expect(phases).not.toContain('loading');
      expect(text()).toBe(kind === 'orders' ? 'ORD-1' : 'Cable');
    }
    yield* waitUntil(() => reads.filter((read) => read === kind).length === 1);
    yield* networkIdle;
    yield* waitUntil(() => text() === (kind === 'orders' ? 'ORD-1' : 'Cable'));
    expect(reads.filter((read) => read === kind)).toHaveLength(1);
    expect(text()).toBe(kind === 'orders' ? 'ORD-1' : 'Cable');
  });
beforeEach(() => {
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  orderDetailData.invalidate();
  productListData.invalidate();
  window.dispatchEvent(new Event(moduleWriteEvent));
  reads.length = 0;
  phases.length = 0;
});
afterEach(() => {
  unmountAll();
});
it.live(
  'returning to orders after thirty seconds immediately shows retained rows and refreshes once',
  () => returnToList('orders').pipe(Effect.provide(network)),
  60_000,
);
it.live(
  'returning to products after thirty seconds immediately shows retained rows and refreshes once',
  () => returnToList('products').pipe(Effect.provide(network)),
  60_000,
);
it.live(
  'a write while orders are closed prevents old rows on their first return render',
  () => returnToList('orders', new Event(moduleWriteEvent)).pipe(Effect.provide(network)),
  60_000,
);
it.live(
  'a write while products are closed prevents old rows on their first return render',
  () => returnToList('products', new Event(moduleWriteEvent)).pipe(Effect.provide(network)),
  60_000,
);
it.live(
  'a merchandise change while orders are closed prevents old rows on their first return render',
  () =>
    returnToList('orders', new CustomEvent(moduleChangeEvent, { detail: { apps: ['merchandise'] } })).pipe(
      Effect.provide(network),
    ),
  60_000,
);
