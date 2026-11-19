// @rstest-environment happy-dom
import { acted, text, unmountAll } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  networkSteady,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createElement, useState } from 'react';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import {
  firstOrdersPage,
  orderDetailData,
  ordersPageData,
  useOrderDetail,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { mountInRoute } from '../support/module-ui.ts';

const context = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const response = (note: string) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 100, orderCount: 1, productCount: 1, stockValueMinor: 100 },
    movements: [],
    orders: [
      {
        createdAt: instant,
        id: 'order-1',
        lines: [
          { productId: 'product-1', productName: 'Cable', quantity: 1, sku: 'CABLE', unitPriceMinor: 100, vatRate: 21 },
        ],
        note,
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
    revision: note === 'Before' ? 7 : 8,
  });
let note = 'Before';
let gate: Deferred.Deferred<boolean> | null;
const Api = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    Api,
    HttpApiBuilder.group(Api, 'records', (group) =>
      group.handle('execute', () =>
        Effect.suspend(() => {
          const records = response(note);
          return gate === null ? Effect.succeed(records) : Deferred.await(gate).pipe(Effect.as(records));
        }),
      ),
    ),
  ),
);
const EditBody = ({ saved }: { readonly saved: string }) => {
  const [draft, setDraft] = useState('');
  return createElement(
    'div',
    null,
    createElement('output', null, saved),
    createElement('input', { 'aria-label': 'Draft', onChange: (event) => setDraft(event.target.value), value: draft }),
  );
};
const source = {
  legalEntityId: context.legalEntityId,
  query: firstOrdersPage(2),
  scope: pageDataScopeKey(context, 'demo.merchandise'),
};
const Detail = ({ id, onOldNote }: { readonly id: string | null; readonly onOldNote?: () => void }) => {
  useOrders(context.legalEntityId, source.query, context, { counts: false, warm: false });
  const current = useOrderDetail(id, 0, context, source);
  if (current.status === 'ready' && current.order.note === 'Before') {
    onOldNote?.();
  }
  return current.status === 'ready'
    ? createElement(EditBody, { saved: current.order.note ?? '' })
    : createElement('output', null, current.status);
};
const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Draft"]');
const open = Effect.gen(function* openDetail() {
  yield* pinTestDocument;
  const view = yield* mountInRoute(createElement(Detail, { id: 'order-1' }));
  yield* networkIdle;
  expect(text()).toBe('Before');
  return view;
});
beforeEach(() => {
  orderDetailData.invalidate();
  ordersPageData.invalidate();
  note = 'Before';
  gate = null;
});
afterEach(unmountAll);
it.live('an open order preserves the same edit input and unsaved draft until revalidation delivers its new note', () =>
  Effect.gen(function* preserveDraft() {
    yield* open;
    const original = field();
    expect(original).not.toBeNull();
    yield* acted(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(original, 'Unsaved draft');
      original?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const release = yield* Deferred.make<boolean>();
    gate = release;
    note = 'After';
    yield* acted(() => {
      orderDetailData.invalidate();
      ordersPageData.invalidate();
    });
    expect(yield* networkSteady).toBeGreaterThan(0);
    expect(text()).toBe('Before');
    expect(field()).toBe(original);
    expect(field()?.value).toBe('Unsaved draft');
    yield* Deferred.succeed(release, true);
    yield* networkIdle;
    expect(text()).toBe('After');
    expect(field()).toBe(original);
    expect(field()?.value).toBe('Unsaved draft');
  }).pipe(Effect.provide(network)),
);
it.live('closing an order clears the held note so reopening cannot show it while a newer note is pending', () =>
  Effect.gen(function* reopen() {
    const view = yield* open;
    yield* view.rerender(createElement(Detail, { id: null }));
    expect(text()).toBe('idle');
    expect(field()).toBeNull();
    note = 'After';
    gate = yield* Deferred.make<boolean>();
    orderDetailData.invalidate();
    ordersPageData.invalidate();
    let oldNoteRendered = false;
    yield* view.rerender(
      createElement(Detail, {
        id: 'order-1',
        onOldNote: () => {
          oldNoteRendered = true;
        },
      }),
    );
    expect(yield* networkSteady).toBeGreaterThan(0);
    expect(text()).toBe('loading');
    expect(oldNoteRendered).toBe(false);
    expect(field()).toBeNull();
    yield* Deferred.succeed(gate, true);
    yield* networkIdle;
    expect(text()).toBe('After');
    expect(field()?.value).toBe('');
    expect(oldNoteRendered).toBe(false);
  }).pipe(Effect.provide(network)),
);
