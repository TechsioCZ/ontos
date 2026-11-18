// @rstest-environment happy-dom
// Intent prefetch through the real list hooks, strict detail store, ui-kit table and generated records client.
// The Shell gateway issuer and owner records API answer in process; cache expiry and pointer dwell run on fake timers.
import { LIST_WARM_ROWS } from '@app/admin-ui';
import { passFakeTime, settleOnFakeTimers, unmountAll } from '@app/admin-ui/testing/module-ui';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef, TanstackTable } from '@techsio/ui-kit/organisms/data-table';
import { Deferred, Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useState } from 'react';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { ProductRecord } from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { useCategoryChoices, useProductPage } from '../../src/routes/[lang]/provoz/produkty/product-list-page.ts';
import {
  categoryChoicesData,
  detailInput,
  firstProductPage,
  productCategoryKey,
  productDetailData,
  productDetailIntent,
  productListData,
  useProductDetail,
  useProductDetailsPrefetch,
} from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

import { mountInRoute } from '../support/module-ui.ts';

const company: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const PAGE_SIZE = 50;
const ROWS = 25;
const REVISION = 7;
/** Row 3 of the page: the one the user points at. */
const POINTED = 2;
const pointedId = `product-${POINTED + 1}`;

const products = Array.from({ length: ROWS }, (_, index) =>
  Schema.encodeSync(ProductRecordSchema)(
    Schema.decodeSync(ProductRecordSchema)({
      active: true,
      category: 'IT',
      createdAt: instant,
      currentPriceMinor: 100,
      id: `product-${index + 1}`,
      lowStock: false,
      lowStockThreshold: 0,
      name: `Cable ${index + 1}`,
      priceHistory: [],
      sku: `CABLE-${index + 1}`,
      stockOnHand: 10,
      stockValueMinor: 1000,
      unit: 'ks',
      updatedAt: instant,
      vatRate: 21,
    }),
  ),
);

const responseOf = (rows: typeof products) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canManageCatalog: true,
    canWrite: true,
    hasCategoryTree: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: ROWS, stockValueMinor: 0 },
    movements: [],
    orders: [],
    productCategories: [],
    products: rows,
    revision: REVISION,
  });

/** Every records read the page sent; a detail read names its product. */
const reads: string[] = [];
/** While set, detail reads wait for it to be released; unset, they answer in the same tick. */
let detailGate: Deferred.Deferred<boolean> | null = null;
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload: { view } }) =>
        Effect.suspend(() => {
          if (view?.includeProductCategories === true) {
            reads.push('choices');
            return Effect.succeed(responseOf([]));
          }
          if (view?.productId !== undefined) {
            reads.push(`detail:${view.productId}`);
            const answer = Effect.succeed(responseOf(products.filter((entry) => entry.id === view.productId)));
            return detailGate === null ? answer : Deferred.await(detailGate).pipe(Effect.andThen(answer));
          }
          reads.push('list');
          return Effect.succeed(responseOf(products));
        }),
      ),
    ),
  ),
);
const detailReads = () => reads.filter((read) => read.startsWith('detail:'));

const columns: ColumnDef<ProductRecord>[] = [{ accessorKey: 'name', id: 'name' }];
const pagination = { pageIndex: 0, pageSize: PAGE_SIZE };

/** The products page as `page.tsx` wires it: choices, one list page, the batch warm-up and the row intent. */
const ProductsList = () => {
  useCategoryChoices(productCategoryKey(company.legalEntityId, company));
  const query = firstProductPage(PAGE_SIZE);
  const { state, viewKey } = useProductPage(company.legalEntityId, query, company);
  const [table, setTable] = useState<TanstackTable<ProductRecord>>();
  const ready = state.status === 'ready' ? state.response : undefined;
  const rows = ready?.products ?? [];
  const shown = state.status === 'ready' && state.query === query;
  const revision = ready?.revision ?? 0;
  useProductDetailsPrefetch(company, revision, viewKey, table, rows, shown);
  return createElement(DataTable<ProductRecord>, {
    columns,
    data: shown ? [...rows] : [],
    enablePagination: true,
    getRowId: (row) => row.id,
    manualPagination: true,
    onReady: setTable,
    onRowClick: constVoid,
    pagination,
    slotProps: { row: productDetailIntent(company, revision, table, rows, shown) },
  });
};

/** What the opened product page renders, from its first render on. */
const opened: string[] = [];
const ProductDetail = () => {
  const detail = useProductDetail(company.legalEntityId, pointedId, company, REVISION);
  opened.push(detail.status);
  return null;
};

const mount = (component: () => ReturnType<typeof createElement> | null) =>
  mountInRoute(createElement(component), {
    path: '/provoz/produkty',
    settle: settleOnFakeTimers,
    url: '/cs/provoz/produkty',
  });

/** Lets fake time pass in one-second steps; the reads each timer starts are answered before the next step. */
const idle = (seconds: number): Effect.Effect<void> => passFakeTime(`${seconds} seconds`, { between: networkIdle });

const rowAt = (index: number): HTMLElement => {
  const row = document.querySelector<HTMLElement>(`tbody tr[data-index="${index}"]`);
  if (row === null) {
    throw new Error('the pointed row is not rendered');
  }
  return row;
};
const pointedRow = (): HTMLElement => rowAt(POINTED);

/** The pointer enters the row (React derives `pointerenter` from `pointerover`). */
const pointAt = Effect.promise(() =>
  act(async () => {
    pointedRow().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    await browserRuntime.runPromise(Effect.yieldNow);
  }),
);

const pointedSnapshot = () =>
  Option.match(detailInput(company.legalEntityId, pointedId, company, REVISION), {
    onNone: () => 'invalid',
    onSome: (input) => productDetailData.snapshot(input).state,
  });

/** Opens the list, lets the warm-up run and then its details go stale. */
const staleList = Effect.gen(function* staleList() {
  yield* mount(ProductsList);
  yield* idle(5);
  // Only the first rows are warmed on opening, not the whole page.
  expect(detailReads()).toHaveLength(LIST_WARM_ROWS);
  yield* idle(20);
  expect(pointedSnapshot()).toBe('pending');
  reads.length = 0;
});

beforeEach(() => {
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  productListData.invalidate();
  productDetailData.invalidate();
  categoryChoicesData.invalidate();
  reads.length = 0;
  opened.length = 0;
  detailGate = null;
});

afterEach(() => {
  unmountAll();
  rstest.useRealTimers();
});

it.live('pointing at a stale row reads its detail once, so the product opens without a loading state', () =>
  Effect.gen(function* pointThenOpen() {
    yield* pinTestDocument;
    yield* staleList;

    yield* pointAt;
    yield* idle(1);
    expect(detailReads()).toEqual([`detail:${pointedId}`]);
    expect(pointedSnapshot()).toBe('ready');

    // Pointing at the same row again while its detail is fresh sends nothing.
    yield* pointAt;
    yield* idle(1);
    expect(detailReads()).toEqual([`detail:${pointedId}`]);

    reads.length = 0;
    yield* mount(ProductDetail);
    expect(opened).not.toContain('loading');
    expect(opened.at(-1)).toBe('ready');
    yield* networkIdle;
    expect(detailReads()).toEqual([]);
  }).pipe(Effect.provide(network)),
);
