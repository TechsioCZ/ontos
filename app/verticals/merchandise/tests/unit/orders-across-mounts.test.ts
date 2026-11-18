// @rstest-environment happy-dom
// What a reopened orders list shows first: the real `useOrders` hook over the real strict stores, with the
// generated records client served through the real HTTP contract and fake timers. A list left for a full order
// page and reopened after 30 s
// starts from its last ready read and reloads once in the background. A write or a live change in between starts it
// loading, as before.
import { moduleChangeEvent, moduleWriteEvent } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { passFakeTime } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { OrderSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { customerDirectoryData } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import {
  firstOrdersPage,
  orderCountsData,
  orderDetailData,
  ordersPageData,
  useOrders,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

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

const responseOf = (rows: { readonly orders?: typeof orders }) =>
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
    products: [],
    revision: 7,
    taxRates: [],
    totalOrders: ROWS,
  });

/** Every records read the page sent, by what it asked for. */
const reads: string[] = [];
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload: { view } }) =>
        Effect.sync(() => {
          if (view?.ordersLimit === 0) {
            reads.push('count');
            return responseOf({});
          }
          reads.push('list');
          return responseOf({ orders });
        }),
      ),
    ),
  ),
);
const count = (kind: string) => reads.filter((read) => read === kind).length;

/** The state kind of every render of the list, in order, since the last reset. */
const renders: string[] = [];
const OrdersList = () => {
  const { state } = useOrders(company.legalEntityId, firstOrdersPage(PAGE_SIZE), company);
  renders.push(state.kind);
  return createElement('output', null, state.kind);
};

let unmount: (() => void) | null = null;

const mount = () =>
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
      root.render(createElement(OrdersList));
      await browserRuntime.runPromise(Effect.yieldNow);
    });
  });

const unmountList = () => {
  unmount?.();
  unmount = null;
};

/** Lets fake time pass in one-second steps; the reads each timer starts are answered before the next step. */
const idle = (seconds: number): Effect.Effect<void> => passFakeTime(`${seconds} seconds`, { between: networkIdle });

const writeHappened = Effect.sync(() => window.dispatchEvent(new Event(moduleWriteEvent)));
const liveChange = (apps: readonly string[]) =>
  Effect.sync(() => window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps } })));

beforeEach(() => {
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  ordersPageData.invalidate();
  orderCountsData.invalidate();
  orderDetailData.invalidate();
  customerDirectoryData.invalidate();
  reads.length = 0;
  renders.length = 0;
  // Empties the copies an earlier test left behind, as any write does.
  window.dispatchEvent(new Event(moduleWriteEvent));
});

afterEach(() => {
  unmountList();
  rstest.useRealTimers();
});

it.live('a list reopened after 30 s shows its last ready read at once and reloads once', () =>
  Effect.gen(function* reopened() {
    yield* pinTestDocument;
    yield* mount();
    yield* idle(5);
    unmountList();
    reads.length = 0;
    renders.length = 0;

    yield* idle(30);
    yield* mount();
    expect(renders[0]).toBe('ready');
    expect(renders).not.toContain('loading');

    yield* idle(5);
    expect(count('list')).toBe(1);
    expect(renders[0]).toBe('ready');
  }).pipe(Effect.provide(network)),
);

it.live('a write in between makes the reopened list load, not show the rows of before', () =>
  Effect.gen(function* afterWrite() {
    yield* pinTestDocument;
    yield* mount();
    yield* idle(5);
    unmountList();
    reads.length = 0;
    renders.length = 0;

    yield* idle(30);
    yield* writeHappened;
    yield* mount();
    expect(renders[0]).toBe('loading');

    yield* idle(5);
    expect(count('list')).toBe(1);
  }).pipe(Effect.provide(network)),
);

it.live('a live change in between makes the reopened list load, not show the rows of before', () =>
  Effect.gen(function* afterChange() {
    yield* pinTestDocument;
    yield* mount();
    yield* idle(5);
    unmountList();
    reads.length = 0;
    renders.length = 0;

    yield* idle(30);
    yield* liveChange(['merchandise']);
    yield* mount();
    expect(renders[0]).toBe('loading');
  }).pipe(Effect.provide(network)),
);
