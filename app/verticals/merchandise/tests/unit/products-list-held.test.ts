// @rstest-environment happy-dom
// The products list across a reload: the real `useProductPage` over the real strict list store and generated
// records client, with the records contract served in process. A reload reads as pending in the strict store, so
// without a held read the table drops to its loading rows and the page loses the capability its actions need.
// The category filter's choices come from a second strict store and decide which category the request carries, so
// they are held the same way: otherwise a reload turns the filtered request into the unfiltered one.
import { acted, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createElement, useEffect } from 'react';
import type { ReactElement } from 'react';
import { RecordsApi, RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { useCategoryChoices, useProductPage } from '../../src/routes/[lang]/provoz/produkty/product-list-page.ts';
import type { ProductLoadState } from '../../src/routes/[lang]/provoz/produkty/product-list-page.ts';
import {
  categoryChoicesData,
  firstProductPage,
  productCategoryKey,
  productListData,
} from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import type { ProductListQuery } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { mountInRoute } from '../support/module-ui.ts';

const company: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const otherCompany: ModulePageContext = { ...company, legalEntityId: 'company-2' };
/** The storefront tree category selected in the filter. */
const TREE_CATEGORY = 'category-cables';
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
const answerOf = (names: readonly string[], revision: number) => ({
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
const recordsOf = (names: readonly string[], revision: number) =>
  Schema.decodeSync(RecordsResponseSchema)(answerOf(names, revision));
/** The answer to the category filter's read: no products, whether the company has a storefront tree. */
const choicesOf = (hasCategoryTree: boolean, revision: number) =>
  Schema.decodeSync(RecordsResponseSchema)({ ...answerOf([], revision), hasCategoryTree, productCategories: [] });
const denied = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});

/** Each case scripts the owner's real records endpoint. */
let respond = (_request: RecordsRequest): Effect.Effect<RecordsResponse, typeof denied> =>
  Effect.succeed(recordsOf([], 0));
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) => Effect.suspend(() => respond(payload))),
    ),
  ),
);

/** The register served by the records endpoint: product names per page offset; with a gate, every read waits for it. */
const serve = (
  pages: Readonly<Record<number, readonly string[]>>,
  revision: number,
  gate?: Deferred.Deferred<boolean>,
) => {
  respond = ({ view }) => {
    const answer = recordsOf(pages[view?.offset ?? 0] ?? [], revision);
    return gate === undefined ? Effect.succeed(answer) : Deferred.await(gate).pipe(Effect.as(answer));
  };
};

/** What the client was asked for: the filter's choices, or a list page with its tree category (`*` = none). */
const requested: string[] = [];

/**
 * A company's register served by the records endpoint: the filter's choices say whether it has a storefront tree, the
 * list holds Cable in the selected tree category and Switch outside it. With a gate, every read waits for it.
 */
const serveCompany = (hasTree: boolean, revision: number, gate?: Deferred.Deferred<boolean>) => {
  respond = ({ view }) => {
    const choices = view?.includeProductCategories === true;
    requested.push(choices ? 'choices' : `list:${view?.categoryId ?? '*'}`);
    const names = view?.categoryId === TREE_CATEGORY ? ['Cable'] : ['Cable', 'Switch'];
    const answer = choices ? choicesOf(hasTree, revision) : recordsOf(names, revision);
    return gate === undefined ? Effect.succeed(answer) : Deferred.await(gate).pipe(Effect.as(answer));
  };
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

/**
 * The list with a storefront tree category selected, as the products page builds it: the choices say whether the
 * filter works by tree, and only then the request carries the selected tree category.
 */
const FilteredProductsTable = ({ context }: { readonly context: ModulePageContext }) => {
  const { choices } = useCategoryChoices(productCategoryKey(context.legalEntityId, context));
  const byTree = choices.hasTree;
  const query: ProductListQuery = { ...firstProductPage(PAGE_SIZE), categoryId: byTree ? TREE_CATEGORY : null };
  const { state } = useProductPage(context.legalEntityId, query, context);
  const table = tableOf(state, query);
  shown.push(`${byTree ? 'tree' : 'labels'}/${table}`);
  return table.startsWith('rows:') ? createElement(Rows, { text: table }) : null;
};

const mountView = <Shown>(render: (shown: Shown) => ReactElement, first: Shown) =>
  Effect.gen(function* mountTable() {
    const view = yield* mountInRoute(render(first), { url: '/cs/provoz/produkty' });
    return { show: (next: Shown) => view.rerender(render(next)) };
  });

const mount = (offset: number) => mountView((next: number) => createElement(ProductsTable, { offset: next }), offset);

const mountFiltered = (context: ModulePageContext) =>
  mountView((next: ModulePageContext) => createElement(FilteredProductsTable, { context: next }), context);

/** A catalog command settled, or a live change arrived: the strict stores drop what they have and read again. */
const invalidate = acted(() => {
  productListData.invalidate();
  categoryChoicesData.invalidate();
}).pipe(Effect.andThen(settle));

const before = 'rows:Cable,Switch|write|r7';
const filteredBefore = 'tree/rows:Cable|write|r7';

beforeEach(() => {
  productListData.invalidate();
  categoryChoicesData.invalidate();
  shown.length = 0;
  requested.length = 0;
  mounts = 0;
});

afterEach(unmountAll);

it.live('a refused reload takes the held rows away at once', () =>
  Effect.gen(function* refused() {
    yield* pinTestDocument;
    serve({ 0: ['Cable', 'Switch'] }, 7);
    yield* mount(0);
    yield* waitUntil(() => shown.at(-1) === before);

    respond = () => Effect.fail(denied);
    yield* invalidate;
    yield* waitUntil(() => shown.at(-1)?.startsWith('error:') === true);
    expect(shown.at(-1)).toBe('error:forbidden');
  }).pipe(Effect.provide(network)),
);

it.live('a tree category stays in the request and its rows on screen while the filter choices reload', () =>
  Effect.gen(function* heldChoices() {
    yield* pinTestDocument;
    serveCompany(true, 7);
    yield* mountFiltered(company);
    yield* waitUntil(() => shown.at(-1) === filteredBefore);
    yield* networkIdle;
    const mountsBefore = mounts;

    const gate = yield* Deferred.make<boolean>();
    serveCompany(true, 8, gate);
    shown.length = 0;
    requested.length = 0;
    yield* invalidate;
    // The reads this started have all arrived; the gate holds 2 of them open.
    yield* networkQuietExcept(2);
    expect(shown.length).toBeGreaterThan(0);
    // The tree filter control and the filtered rows stay; the table does not turn to the unfiltered page.
    expect(new Set(shown)).toEqual(new Set([filteredBefore]));

    yield* Deferred.succeed(gate, true);
    yield* waitUntil(() => shown.at(-1) === 'tree/rows:Cable|write|r8');
    yield* networkIdle;
    expect(new Set(shown)).toEqual(new Set([filteredBefore, 'tree/rows:Cable|write|r8']));
    expect(requested.filter((request) => request === 'list:*')).toEqual([]);
    expect(mounts).toBe(mountsBefore);
  }).pipe(Effect.provide(network)),
);

it.live('another company never gets the tree filter of the company before it', () =>
  Effect.gen(function* otherCompanyChoices() {
    yield* pinTestDocument;
    serveCompany(true, 7);
    const view = yield* mountFiltered(company);
    yield* waitUntil(() => shown.at(-1) === filteredBefore);

    const gate = yield* Deferred.make<boolean>();
    serveCompany(false, 3, gate);
    shown.length = 0;
    requested.length = 0;
    yield* view.show(otherCompany);
    yield* settle;
    // The reads this started have all arrived; the gate holds 2 of them open.
    yield* networkQuietExcept(2);
    expect(new Set(shown)).toEqual(new Set(['labels/loading']));

    yield* Deferred.succeed(gate, true);
    yield* waitUntil(() => shown.at(-1) === 'labels/rows:Cable,Switch|write|r3');
    yield* networkIdle;
    expect(shown.filter((table) => table.startsWith('tree/'))).toEqual([]);
    expect(requested.filter((request) => request === `list:${TREE_CATEGORY}`)).toEqual([]);
  }).pipe(Effect.provide(network)),
);
