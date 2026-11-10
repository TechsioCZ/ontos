// @rstest-environment happy-dom
// The products list across a reload: the real `useProductPage` over the real strict list store, with only the
// generated records client replaced. A reload of the request on screen reads as pending in the strict store, so
// without a held read the table drops to its loading rows and the page loses the capability its actions need.
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { useProductPage } from '../../src/routes/[lang]/provoz/produkty/product-list-page.ts';
import type { ProductLoadState } from '../../src/routes/[lang]/provoz/produkty/product-list-page.ts';
import { firstProductPage, productListData } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import type { ProductListQuery } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');

const company: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const PAGE_SIZE = 2;

const productOf = (name: string) =>
  Schema.encodeSync(ProductRecordSchema)(
    Schema.decodeSync(ProductRecordSchema)({
      active: true,
      category: 'IT',
      createdAt: instant,
      currentPriceMinor: 100,
      id: `product-${name}`,
      lowStock: false,
      lowStockThreshold: 0,
      name,
      priceHistory: [],
      sku: name,
      stockOnHand: 10,
      stockValueMinor: 1000,
      unit: 'ks',
      updatedAt: instant,
      vatRate: 21,
    }),
  );
const recordsOf = (names: readonly string[], revision: number) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canManageCatalog: true,
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 4, stockValueMinor: 4000 },
    movements: [],
    orders: [],
    products: names.map(productOf),
    revision,
  });
const denied = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});

/** The register behind the mocked client: product names per page offset; with a gate, every read waits for it. */
const serve = (
  pages: Readonly<Record<number, readonly string[]>>,
  revision: number,
  gate?: Deferred.Deferred<boolean>,
) => {
  rstest.mocked(executeRecords).mockImplementation(({ view }) => {
    const answer = recordsOf(pages[view?.offset ?? 0] ?? [], revision);
    return gate === undefined ? Effect.succeed(answer) : Deferred.await(gate).pipe(Effect.as(answer));
  });
};

/** What the table showed on every render, and how often its rows mounted. */
const shown: string[] = [];
let mounts = 0;

/** What the products page makes of the hook: rows only for the request on screen, otherwise the loading rows. */
const tableOf = (state: ProductLoadState, query: ProductListQuery): string => {
  if (state.status !== 'ready') {
    return state.status === 'error' ? `error:${state.reason}` : state.status;
  }
  if (state.query !== query) {
    return 'loading';
  }
  const names = state.response.products.map((product) => product.name).join(',');
  return `rows:${names}|${state.response.canManageCatalog === true ? 'write' : 'read-only'}|r${state.response.revision}`;
};

/** Stands for the table body with its rows: it exists only while the rows are on screen. */
const Rows = ({ text }: { readonly text: string }) => {
  useEffect(() => {
    mounts += 1;
  }, []);
  return createElement('output', null, text);
};

const ProductsTable = ({ offset }: { readonly offset: number }) => {
  // The page builds the request on every render, as here.
  const query: ProductListQuery = { ...firstProductPage(PAGE_SIZE), offset };
  const { state } = useProductPage(company.legalEntityId, query, company);
  const table = tableOf(state, query);
  shown.push(table);
  return table.startsWith('rows:') ? createElement(Rows, { text: table }) : null;
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

interface Mounted {
  readonly show: (offset: number) => Effect.Effect<void>;
}

let unmount: (() => void) | null = null;

const mount = (offset: number): Effect.Effect<Mounted> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => {
      root.unmount();
      container.remove();
    });
  };
  const show = (nextOffset: number) =>
    Effect.promise(() =>
      act(async () => {
        root.render(createElement(ProductsTable, { offset: nextOffset }));
        await settle();
      }),
    );
  return show(offset).pipe(Effect.as({ show }));
};

/** A catalog command settled, or a live change arrived: the strict store drops what it has and reads again. */
const invalidate = Effect.promise(async () => {
  await act(async () => {
    productListData.invalidate();
    await settle();
  });
  await act(settle);
});

const before = 'rows:Cable,Switch|write|r7';

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  productListData.invalidate();
  shown.length = 0;
  mounts = 0;
});

afterEach(() => {
  unmount?.();
  unmount = null;
  rstest.unstubAllGlobals();
});

it.effect('the rows and the write capability stay on screen while the same page reloads', () =>
  Effect.gen(function* held() {
    serve({ 0: ['Cable', 'Switch'] }, 7);
    yield* mount(0);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === before));
    expect(mounts).toBe(1);

    const gate = yield* Deferred.make<boolean>();
    serve({ 0: ['Cable 2 m', 'Switch'] }, 8, gate);
    shown.length = 0;
    yield* invalidate;
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown)).toEqual(new Set([before]));

    yield* Deferred.succeed(gate, true);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'rows:Cable 2 m,Switch|write|r8'));
    expect(shown.filter((table) => !table.startsWith('rows:'))).toEqual([]);
    expect(mounts).toBe(1);
  }),
);

it.effect('another page never shows the rows of the page before it, held or not', () =>
  Effect.gen(function* otherPage() {
    serve({ 0: ['Cable', 'Switch'], 2: ['Router', 'Rack'] }, 7);
    const view = yield* mount(0);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === before));

    // A write reloads the first page; while it is on its way the person moves to the second page.
    const gate = yield* Deferred.make<boolean>();
    serve({ 0: ['Cable', 'Switch'], 2: ['Router', 'Rack'] }, 8, gate);
    yield* invalidate;
    shown.length = 0;
    yield* view.show(2);
    yield* Effect.promise(() => act(settle));
    expect(new Set(shown)).toEqual(new Set(['loading']));

    yield* Deferred.succeed(gate, true);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'rows:Router,Rack|write|r8'));
    expect(shown.filter((table) => table.startsWith('rows:Cable'))).toEqual([]);
  }),
);

it.effect('a refused reload takes the held rows away at once', () =>
  Effect.gen(function* refused() {
    serve({ 0: ['Cable', 'Switch'] }, 7);
    yield* mount(0);
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === before));

    rstest.mocked(executeRecords).mockReturnValue(Effect.fail(denied));
    yield* invalidate;
    yield* Effect.promise(() => waitUntil(() => shown.at(-1)?.startsWith('error:') === true));
    expect(shown.at(-1)).toBe('error:forbidden');
  }),
);
