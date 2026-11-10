// @rstest-environment happy-dom
// How many records reads an idle products list and an idle product detail send: the real hooks over the real strict
// stores and the ui-kit table, with only the generated records client replaced and the clock faked. An idle page
// reloads what it shows after the 20 s freshness window, after a live change and after a write: a few reads a minute.
// The details warmed for the list's rows are read once per list revision, not again whenever they expire.
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef, TanstackTable } from '@techsio/ui-kit/organisms/data-table';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { ProductRecord } from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { useCategoryChoices, useProductPage } from '../../src/routes/[lang]/provoz/produkty/product-list-page.ts';
import {
  categoryChoicesData,
  firstProductPage,
  productCategoryKey,
  productDetailData,
  productListData,
  useProductDetail,
  useProductDetailsPrefetch,
} from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');

const company: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const PAGE_SIZE = 50;
const ROWS = 25;

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

/** The owner revision the register answers with; a write moves it. */
const register = { revision: 7 };
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
    revision: register.revision,
  });

/** Every records read the page sent, by what it asked for. */
const reads: string[] = [];
const serve = () => {
  rstest.mocked(executeRecords).mockImplementation(({ view }) => {
    if (view?.includeProductCategories === true) {
      reads.push('choices');
      return Effect.succeed(responseOf([]));
    }
    if (view?.productId !== undefined) {
      reads.push('detail');
      return Effect.succeed(responseOf(products.filter((entry) => entry.id === view.productId)));
    }
    reads.push('list');
    return Effect.succeed(responseOf(products));
  });
};
const count = (kind: string) => reads.filter((read) => read === kind).length;

const columns: ColumnDef<ProductRecord>[] = [{ accessorKey: 'name', id: 'name' }];
const pagination = { pageIndex: 0, pageSize: PAGE_SIZE };

/** The products page's reads as `page.tsx` wires them: choices, one list page and the details warm-up of its rows. */
const ProductsList = () => {
  useCategoryChoices(productCategoryKey(company.legalEntityId, company));
  const query = firstProductPage(PAGE_SIZE);
  const { state, viewKey } = useProductPage(company.legalEntityId, query, company);
  const [table, setTable] = useState<TanstackTable<ProductRecord>>();
  const ready = state.status === 'ready' ? state.response : undefined;
  const rows = ready?.products ?? [];
  const shown = state.status === 'ready' && state.query === query;
  useProductDetailsPrefetch(company, ready?.revision ?? 0, viewKey, table, rows, shown);
  return createElement(DataTable<ProductRecord>, {
    columns,
    data: shown ? [...rows] : [],
    enablePagination: true,
    getRowId: (row) => row.id,
    manualPagination: true,
    onReady: setTable,
    pagination,
  });
};

const ProductDetail = () => {
  const detail = useProductDetail(company.legalEntityId, 'product-1', company, 7);
  return createElement('output', null, detail.status);
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

/** Lets fake time pass in one-second steps, so every timer and every render it causes runs in between. */
const idle = (seconds: number): Effect.Effect<void> =>
  seconds <= 0
    ? Effect.void
    : Effect.promise(() =>
        act(async () => {
          await rstest.advanceTimersByTimeAsync(1000);
        }),
      ).pipe(Effect.andThen(Effect.suspend(() => idle(seconds - 1))));

/** The Shell's live channel reports a change committed elsewhere (another module, session or worker). */
const liveChange = Effect.sync(() => globalThis.dispatchEvent(new Event(moduleChangeEvent)));

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  rstest.resetAllMocks();
  productListData.invalidate();
  productDetailData.invalidate();
  categoryChoicesData.invalidate();
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

it.effect('an idle products list reloads its page and choices every 20 s and warms its rows once', () =>
  Effect.gen(function* idleList() {
    yield* mount(ProductsList);
    yield* idle(5);
    // Opening the page: the choices, the page and one warm-up read of each row's detail.
    expect([count('choices'), count('list'), count('detail')]).toEqual([1, 1, ROWS]);
    reads.length = 0;

    yield* idle(60);
    // A minute: the page and the choices on each expiry of the freshness window, the unchanged rows not again.
    expect(count('list')).toBeGreaterThanOrEqual(2);
    expect(reads.length).toBeLessThanOrEqual(6);
    expect(count('detail')).toBe(0);
  }),
);

it.effect('live changes reload the page on screen, not the details of its unchanged rows', () =>
  Effect.gen(function* liveList() {
    yield* mount(ProductsList);
    yield* idle(5);
    reads.length = 0;

    for (let event = 0; event < 5; event += 1) {
      yield* liveChange;
      yield* idle(2);
    }
    expect(count('list')).toBe(5);
    expect(count('detail')).toBe(0);
  }),
);

it.effect('a write that moves the revision reloads the page and warms its rows again', () =>
  Effect.gen(function* afterWrite() {
    yield* mount(ProductsList);
    yield* idle(5);
    reads.length = 0;

    register.revision = 8;
    yield* Effect.sync(() => {
      productListData.invalidate();
      productDetailData.invalidate();
      categoryChoicesData.invalidate();
    });
    yield* idle(5);
    expect([count('choices'), count('list'), count('detail')]).toEqual([1, 1, ROWS]);
  }),
);

it.effect('an idle product detail reloads its record on each expiry of the freshness window only', () =>
  Effect.gen(function* idleDetail() {
    yield* mount(ProductDetail);
    yield* idle(5);
    expect(reads).toEqual(['detail']);
    reads.length = 0;

    yield* idle(60);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.length).toBeLessThanOrEqual(3);
  }),
);
