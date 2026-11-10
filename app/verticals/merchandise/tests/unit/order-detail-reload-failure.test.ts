// @rstest-environment happy-dom
// The open order across a failed reload: the real `useOrderDetail` over the real strict stores, with only the
// generated records client replaced. A reload of the order on screen that fails keeps the detail and its edit form
// mounted with the unsaved draft and reports the failure; a first read that fails or a denied one shows no order.
import { pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  OrderSchema,
  ProductRecordSchema,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  RecordsUnavailableProblemSchema,
} from '../../shared/apis/records.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import {
  firstOrdersPage,
  orderDetailData,
  ordersPageData,
  useOrderDetail,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
rstest.mock('../../src/api/change-order-status-action-client.ts');

const context = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const scope = pageDataScopeKey(context, 'demo.merchandise') ?? '';
const instant = '2026-10-15T10:00:00Z';
const orderOf = (note: string) =>
  Schema.encodeSync(OrderSchema)(
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
    }),
  );
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
    orders: [orderOf(note)],
    products: [],
    revision,
  });
const unavailable = Schema.decodeSync(RecordsUnavailableProblemSchema)({
  _tag: 'RecordsUnavailableProblem',
  detail: 'Try again',
  retryable: true,
  status: 503,
  title: 'Unavailable',
  type: 'urn:test:unavailable',
});
const denied = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});
const source = { legalEntityId: context.legalEntityId, query: firstOrdersPage(2), scope };

const serve = (note: string, revision: number) => {
  const records = recordsOf(note, revision);
  rstest
    .mocked(executeRecords)
    .mockImplementation(({ view }) =>
      Effect.succeed(
        view?.productId !== undefined || view?.productIds !== undefined
          ? { ...records, orders: [], products: [product] }
          : records,
      ),
    );
};
const refuse = (problem: typeof unavailable | typeof denied) => {
  rstest.mocked(executeRecords).mockReturnValue(Effect.fail(problem));
};

/** What the detail showed on every render, how often the edit form mounted, and its typed draft. */
const shown: string[] = [];
let mounts = 0;
let typeDraft: ((text: string) => void) | null = null;

/** Stands for the edit form: it exists only while the detail is ready, and keeps its own unsaved draft. */
const EditForm = ({ note }: { readonly note: string }) => {
  const [draft, setDraft] = useState(note);
  useEffect(() => {
    mounts += 1;
    typeDraft = setDraft;
  }, []);
  return createElement('output', null, draft);
};

const OpenOrder = () => {
  useSyncExternalStore(
    (listener) => ordersPageData.subscribe(listener, source),
    () => ordersPageData.snapshot(source),
    () => pageDataPending,
  );
  const detail = useOrderDetail('order-1', 0, context, source);
  useEffect(() => {
    ordersPageData.ensure(source);
  }, []);
  shown.push(
    detail.status === 'ready'
      ? `ready:${detail.order.note ?? ''}:${detail.reloadFailure === undefined ? 'current' : 'failed'}`
      : detail.status,
  );
  return detail.status === 'ready' ? createElement(EditForm, { note: detail.order.note ?? '' }) : null;
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

let container: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

const open = Effect.promise(() =>
  act(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    root.render(createElement(OpenOrder));
    await settle();
  }),
);

/** A write settles: the list and the detail read again. */
const reload = Effect.promise(() =>
  act(async () => {
    ordersPageData.invalidate();
    orderDetailData.invalidate();
    await settle();
  }),
);

const text = () => container?.textContent ?? '';

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  orderDetailData.invalidate();
  ordersPageData.invalidate();
  shown.length = 0;
  mounts = 0;
});

afterEach(() => {
  act(() => {
    root?.unmount();
    container?.remove();
  });
  root = null;
  container = null;
  rstest.unstubAllGlobals();
});

it.effect('a failed reload keeps the order and its edit draft on screen and reports it; a retry clears it', () =>
  Effect.gen(function* failedReload() {
    serve('před změnou', 7);
    yield* open;
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'ready:před změnou:current'));
    yield* Effect.promise(() => act(async () => typeDraft?.('rozepsaná poznámka')));

    refuse(unavailable);
    shown.length = 0;
    yield* reload;
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'ready:před změnou:failed'));
    expect(shown.filter((state) => !state.startsWith('ready:'))).toEqual([]);
    expect(mounts).toBe(1);
    expect(text()).toBe('rozepsaná poznámka');

    serve('po změně', 8);
    yield* reload;
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'ready:po změně:current'));
    expect(mounts).toBe(1);
    expect(text()).toBe('rozepsaná poznámka');
  }),
);

it.effect('a first read that fails shows the error, never an order', () =>
  Effect.gen(function* firstFailure() {
    refuse(unavailable);
    yield* open;
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'error'));
    expect(mounts).toBe(0);
  }),
);

it.effect('a denied reload drops the shown order at once', () =>
  Effect.gen(function* deniedReload() {
    serve('před změnou', 7);
    yield* open;
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'ready:před změnou:current'));
    refuse(denied);
    yield* reload;
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'error'));
    expect(text()).toBe('');
  }),
);
