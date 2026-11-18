// @rstest-environment happy-dom
// The open order across a reload: the real `useOrderDetail`, strict stores and generated records client.
// The Shell gateway issuer and merchandise records endpoint answer in process through their real contracts.
// The held read keeps the edit form mounted while a write reloads the list and detail.
import { acted, settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { act, createElement, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { OrderSchema, ProductRecordSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import {
  firstOrdersPage,
  orderDetailData,
  ordersPageData,
  useOrderDetail,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';

const context = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const scope = pageDataScopeKey(context, 'demo.merchandise') ?? '';
const instant = '2026-10-15T10:00:00Z';
const orderOf = (note: string) =>
  Schema.decodeSync(OrderSchema)({
    createdAt: instant,
    id: 'order-1',
    lines: [
      { productId: 'product-1', productName: 'Cable', quantity: 2, sku: 'CABLE', unitPriceMinor: 100, vatRate: 21 },
    ],
    note,
    number: 'ORD-1',
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
const recordsOf = (note: string, revision: number) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 200, orderCount: 1, productCount: 1, stockValueMinor: 1000 },
    movements: [],
    orders: [Schema.encodeSync(OrderSchema)(orderOf(note))],
    products: [],
    revision,
  });
const source = { legalEntityId: context.legalEntityId, query: firstOrdersPage(2), scope };

/** The register answers the list page and the order's products at one revision. */
let answer: Effect.Effect<RecordsResponse> = Effect.succeed(recordsOf('', 0));
const serve = (note: string, revision: number, gate?: Deferred.Deferred<boolean>) => {
  const records = recordsOf(note, revision);
  answer = gate === undefined ? Effect.succeed(records) : Deferred.await(gate).pipe(Effect.as(records));
};

const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => answer).pipe(
          Effect.map((records) =>
            payload.view?.productId !== undefined || payload.view?.productIds !== undefined
              ? { ...records, orders: [], products: [product] }
              : records,
          ),
        ),
      ),
    ),
  ),
);

/** What the detail showed on every render, and how often the view under it mounted. */
const shown: string[] = [];
let mounts = 0;

/** Stands for the detail body with its edit form: it exists only while the detail is ready. */
const Body = ({ note }: { readonly note: string }) => {
  useEffect(() => {
    mounts += 1;
  }, []);
  return createElement('output', null, note);
};

const OpenOrder = ({ orderId = 'order-1' }: { readonly orderId?: string | null }) => {
  // The orders page reads the list too, which is what reloads it after a write.
  useSyncExternalStore(
    (listener) => ordersPageData.subscribe(listener, source),
    () => ordersPageData.snapshot(source),
    () => pageDataPending,
  );
  const detail = useOrderDetail(orderId, 0, context, source);
  useEffect(() => {
    ordersPageData.ensure(source);
  }, []);
  shown.push(detail.status === 'ready' ? `ready:${detail.order.note ?? ''}` : detail.status);
  return detail.status === 'ready' ? createElement(Body, { note: detail.order.note ?? '' }) : null;
};

let unmount: (() => void) | null = null;

beforeEach(() => {
  orderDetailData.invalidate();
  ordersPageData.invalidate();
  shown.length = 0;
  mounts = 0;
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

it.live('the open order stays on screen and mounted while a write reloads the list and the order', () =>
  Effect.gen(function* held() {
    yield* pinTestDocument;
    serve('před změnou', 7);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => {
        root.unmount();
        container.remove();
      });
    };
    yield* acted(() => root.render(createElement(OpenOrder)));
    yield* waitUntil(() => shown.at(-1) === 'ready:před změnou');
    expect(mounts).toBe(1);

    // An order command settles: both stores are invalidated, and the reload is still on its way.
    const gate = yield* Deferred.make<boolean>();
    serve('po změně', 8, gate);
    shown.length = 0;
    yield* acted(() => {
      ordersPageData.invalidate();
      orderDetailData.invalidate();
    });
    yield* settle;
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown)).toEqual(new Set(['ready:před změnou']));

    yield* Deferred.succeed(gate, true);
    yield* waitUntil(() => shown.at(-1) === 'ready:po změně');
    expect(shown.filter((state) => !state.startsWith('ready:'))).toEqual([]);
    expect(mounts).toBe(1);
  }).pipe(Effect.provide(network)),
);

it.live('an order opened again after its panel closed never shows the read held before it closed', () =>
  Effect.gen(function* reopened() {
    yield* pinTestDocument;
    serve('před změnou', 7);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => {
        root.unmount();
        container.remove();
      });
    };
    const show = (orderId: string | null) => acted(() => root.render(createElement(OpenOrder, { orderId })));
    yield* show('order-1');
    yield* waitUntil(() => shown.at(-1) === 'ready:před změnou');

    // The panel closes; the order changes while it is closed, and its fresh read is still on its way.
    yield* show(null);
    expect(shown.at(-1)).toBe('idle');
    const gate = yield* Deferred.make<boolean>();
    serve('po změně', 8, gate);
    yield* acted(() => {
      ordersPageData.invalidate();
      orderDetailData.invalidate();
    });
    shown.length = 0;
    yield* show('order-1');
    yield* settle;
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toContain('ready:před změnou');

    yield* Deferred.succeed(gate, true);
    yield* waitUntil(() => shown.at(-1) === 'ready:po změně');
    expect(shown).not.toContain('ready:před změnou');
  }).pipe(Effect.provide(network)),
);
