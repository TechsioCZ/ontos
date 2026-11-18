// @rstest-environment happy-dom
// What a reopened products list shows first: the real `useProductPage` hook over the real strict list store, with
// the generated records client served through its real HTTP contract and fake timers. A list left for a full
// product page and reopened after 30 s starts from its last ready read and reloads once in the background.
// A write in between starts it loading, as before.
import { moduleWriteEvent } from '@app/shared-contracts/page-data';
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
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { useProductPage } from '../../src/routes/[lang]/provoz/produkty/product-list-page.ts';
import { firstProductPage, productListData } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

const company: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const PAGE_SIZE = 2;

const product = Schema.encodeSync(ProductRecordSchema)(
  Schema.decodeSync(ProductRecordSchema)({
    active: true,
    category: 'IT',
    createdAt: instant,
    currentPriceMinor: 100,
    id: 'product-cable',
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

const responseOf = (
  products: readonly (typeof product)[],
  tax: Pick<typeof RecordsResponseSchema.Encoded, 'sellerVatRegime' | 'taxRates'>,
) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canManageCatalog: true,
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 1, stockValueMinor: 1000 },
    movements: [],
    orders: [],
    products,
    revision: 7,
    ...tax,
  });

/** Every list read the page sent. */
const reads: string[] = [];
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () =>
        Effect.sync(() => {
          reads.push('list');
          return responseOf([product], { taxRates: [] });
        }),
      ),
    ),
  ),
);
const count = (kind: string) => reads.filter((read) => read === kind).length;

/** The status of every render of the list, in order, since the last reset. */
const renders: string[] = [];
const ProductsList = () => {
  const { state } = useProductPage(company.legalEntityId, firstProductPage(PAGE_SIZE), company);
  renders.push(state.status);
  return createElement('output', null, state.status);
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
      root.render(createElement(ProductsList));
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

beforeEach(() => {
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  productListData.invalidate();
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
