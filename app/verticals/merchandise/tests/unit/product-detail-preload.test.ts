import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Deferred, Effect, Fiber, Option, Schema } from 'effect';
import { createElement } from 'react';
import type ReactRuntime from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleChangeEvent, moduleWriteEvent, pageDataPending } from '@app/shared-contracts/page-data';
import { RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { ManageCatalogActionConflictProblemSchema } from '../../shared/apis/manage-catalog-action.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import type { ProductRecord } from '../../shared/domain/merchandise-model.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import {
  currentProductRows,
  detailInput,
  detailState,
  firstProductPage,
  prepareProductDetail,
  preloadProductDetails,
  productDetailData,
  productDetailSearch,
  productListData,
  productRevisionOf,
  runCommand,
  useProductDetail,
} from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import type { CommandOutcome } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
// Verify the client first-render branch without effects or an unrelated browser/component suite.
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof ReactRuntime>('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));

const events = new EventTarget();
const browserGlobals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};
beforeAll(() => {
  for (const [key, value] of Object.entries(browserGlobals)) {
    Reflect.set(globalThis, key, value);
  }
});
afterAll(() => {
  for (const key of Object.keys(browserGlobals)) {
    Reflect.deleteProperty(globalThis, key);
  }
});

const context = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const products = Array.from({ length: 6 }, (_, index) =>
  Schema.decodeSync(ProductRecordSchema)({
    active: true,
    category: 'IT',
    categoryId: 'category-1',
    createdAt: instant,
    currentPriceMinor: 100,
    description: 'Actual product detail',
    id: `product-${index + 1}`,
    lowStock: false,
    lowStockThreshold: 0,
    name: `Cable ${index + 1}`,
    parameters: [{ label: 'Length', unit: 'm', value: '2' }],
    priceHistory: [{ effectiveFrom: instant, previousPriceMinor: 90, priceMinor: 100 }],
    sku: `CABLE-${index + 1}`,
    stockOnHand: 8,
    stockValueMinor: 800,
    unit: 'ks',
    updatedAt: instant,
    variantRecords: [
      {
        active: true,
        attributes: 'black',
        availability: 'IN_STOCK',
        grossPriceMinor: 121,
        id: `variant-${index + 1}`,
        name: 'Black cable',
        priceHistory: [{ effectiveFrom: instant, priceMinor: 100 }],
        priceMinor: 100,
        sku: 'BLACK',
        stockOnHand: 8,
      },
    ],
    vatRate: 21,
  }),
);
const [product] = products;
if (product === undefined) {
  throw new Error('Fixture product required');
}
const response = Schema.decodeSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  canManageCatalog: true,
  canManageMarkets: true,
  canWrite: true,
  categoryTrails: [{ id: 'category-1', trail: 'Electronics / Cables' }],
  hasCategoryTree: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 6, stockValueMinor: 4800 },
  movements: [
    { at: instant, delta: 8, id: 'movement-1', productId: product.id, reason: 'RECEIPT', reference: 'receipt-1' },
  ],
  orders: [],
  productMarkets: [
    {
      currency: 'EUR',
      grossPriceMinor: 5,
      marketCode: 'AKROS-SK',
      marketId: '6a000000-0000-4000-8000-0000000000a1',
      offered: true,
    },
  ],
  products: [Schema.encodeSync(ProductRecordSchema)(product)],
  revision: 7,
  storefrontOrigin: 'https://shop.example.test',
});
const input = Option.getOrThrow(detailInput(context.legalEntityId, product.id, context, 7));
const denied = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});

beforeEach(() => {
  rstest.resetAllMocks();
  productListData.invalidate();
  productDetailData.invalidate();
  rstest.mocked(executeRecords).mockImplementation(({ view }) =>
    Effect.succeed({
      ...response,
      products: products.filter((entry) => entry.id === view?.productId),
    }),
  );
});

const renderProductState = (id: string, scope: typeof context, revision: number) => {
  const StateProbe = () =>
    createElement('output', null, useProductDetail(scope.legalEntityId, id, scope, revision).status);
  return renderToStaticMarkup(createElement(StateProbe)).replaceAll(/<[^>]*>/gu, '');
};

it.effect(
  'a warmed product opens with complete base, variants, histories, ledger, category and admitted markets without a request',
  () =>
    Effect.gen(function* warmOpen() {
      yield* preloadProductDetails(context, 7, [product]);
      expect(executeRecords).toHaveBeenCalledTimes(1);
      expect(rstest.mocked(executeRecords).mock.calls[0]?.[0]).toEqual({
        view: { categoryTrails: true, ordersLimit: 0, productId: product.id },
      });
      const cached = productDetailData.snapshot(input);
      expect(cached.state).toBe('ready');
      rstest.mocked(executeRecords).mockClear();
      yield* prepareProductDetail({
        context,
        routeParams: { id: product.id },
        search: '?productRevision=7',
      });
      const ProductProbe = () => {
        const detail = useProductDetail(context.legalEntityId, product.id, context, 7);
        return createElement(
          'output',
          null,
          detail.status === 'ready'
            ? [
                detail.product.name,
                detail.product.variantRecords?.[0]?.sku,
                detail.product.priceHistory.length,
                detail.response.movements[0]?.reference,
                detail.response.categoryTrails?.[0]?.trail,
                detail.response.productMarkets?.[0]?.marketCode,
                detail.response.revision,
              ].join('|')
            : detail.status,
        );
      };
      expect(renderToStaticMarkup(createElement(ProductProbe))).toBe(
        '<output>Cable 1|BLACK|1|receipt-1|Electronics / Cables|AKROS-SK|7</output>',
      );
      expect(productDetailData.snapshot(input)).toBe(cached);
      expect(executeRecords).not.toHaveBeenCalled();
      expect(executeManageCatalog).not.toHaveBeenCalled();
    }),
);

it.effect('prefetch follows the final kit row order, not a source-array page slice', () =>
  Effect.gen(function* finalRowModel() {
    const final: ProductRecord[] = [];
    for (const row of products.slice(2, 4)) {
      final.unshift(row);
    }
    const table = { getRowModel: () => ({ rows: final.map((original) => ({ original })) }) };
    const rows = currentProductRows(table, products);
    expect(rows).toEqual(final);
    yield* preloadProductDetails(context, 7, rows);
    expect(rstest.mocked(executeRecords).mock.calls.map(([request]) => request.view?.productId)).toEqual(
      final.map((row) => row.id),
    );
    expect(executeManageCatalog).not.toHaveBeenCalled();
  }),
);

it.effect('warming preserves read-only capabilities without requesting mutations or wider catalog data', () =>
  Effect.gen(function* readOnlyProduct() {
    const readOnly = {
      ...response,
      canManageCatalog: false,
      canManageMarkets: false,
      canWrite: false,
      productMarkets: [],
    };
    rstest.mocked(executeRecords).mockReturnValue(Effect.succeed(readOnly));
    yield* preloadProductDetails(context, 7, [product]);
    const detail = yield* productDetailData.read(input);
    expect(detail.response.canWrite).toBe(false);
    expect(detail.response.canManageCatalog).toBe(false);
    expect(detail.response.canManageMarkets).toBe(false);
    expect(detail.response.productMarkets).toEqual([]);
    expect(rstest.mocked(executeRecords).mock.calls[0]?.[0]).toEqual({
      view: { categoryTrails: true, ordersLimit: 0, productId: product.id },
    });
    expect(executeRecords).toHaveBeenCalledTimes(1);
    expect(executeManageCatalog).not.toHaveBeenCalled();
  }),
);

it.effect('an obsolete table model cannot prefetch a new source page or scope', () =>
  Effect.gen(function* obsoleteModel() {
    const old = { getRowModel: () => ({ rows: [{ original: product }] }) };
    const nextSource = products.map((entry) => ({ ...entry }));
    expect(currentProductRows(old, nextSource)).toEqual([]);
    yield* preloadProductDetails(context, 7, currentProductRows(old, nextSource));
    expect(executeRecords).not.toHaveBeenCalled();
  }),
);

it.effect('two background requests at most; cancelling a page stops its active requests and queued rows', () =>
  Effect.gen(function* cancellation() {
    const started = yield* Deferred.make<true>();
    let active = 0;
    let peak = 0;
    rstest.mocked(executeRecords).mockImplementation(() =>
      Effect.sync(() => {
        active += 1;
        peak = Math.max(peak, active);
      }).pipe(
        Effect.andThen(Deferred.succeed(started, true)),
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            active -= 1;
          }),
        ),
      ),
    );
    const background = yield* Effect.forkChild(preloadProductDetails(context, 7, products));
    yield* Deferred.await(started);
    yield* Effect.yieldNow;
    expect(active).toBe(2);
    expect(peak).toBe(2);
    yield* Fiber.interrupt(background);
    expect(active).toBe(0);
    expect(executeRecords).toHaveBeenCalledTimes(2);
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
  }),
);

it.effect('a foreground opening joins the row in flight and keeps it alive when the old table batch is cancelled', () =>
  Effect.gen(function* foregroundJoin() {
    const started = yield* Deferred.make<true>();
    const gate = yield* Deferred.make<true>();
    rstest
      .mocked(executeRecords)
      .mockReturnValue(Deferred.succeed(started, true).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(response)));
    const background = yield* Effect.forkChild(preloadProductDetails(context, 7, [product]));
    yield* Deferred.await(started);
    const foreground = yield* Effect.forkChild(productDetailData.read(input));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(background);
    yield* Deferred.succeed(gate, true);
    yield* Fiber.join(foreground);
    expect(executeRecords).toHaveBeenCalledTimes(1);
    expect(productDetailData.snapshot(input).state).toBe('ready');
  }),
);

it.effect('foreground work bypasses two unrelated background rows', () =>
  Effect.gen(function* foregroundPriority() {
    const started = yield* Deferred.make<true>();
    rstest.mocked(executeRecords).mockReturnValue(Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)));
    const background = yield* Effect.forkChild(preloadProductDetails(context, 7, products.slice(0, 2)));
    yield* Deferred.await(started);
    yield* Effect.yieldNow;
    const third = products.at(2);
    expect(third).toBeDefined();
    if (third === undefined) {
      return;
    }
    const foregroundInput = Option.getOrThrow(detailInput(context.legalEntityId, third.id, context, 7));
    const foreground = yield* Effect.forkChild(productDetailData.read(foregroundInput));
    yield* Effect.yieldNow;
    expect(executeRecords).toHaveBeenCalledTimes(3);
    yield* Fiber.interrupt(foreground);
    yield* Fiber.interrupt(background);
  }),
);

it.effect('full tenant, company, principal and owner revision isolate cached products', () =>
  Effect.gen(function* identity() {
    yield* preloadProductDetails(context, 7, [product]);
    for (const field of ['tenantId', 'legalEntityId', 'principalId'] as const) {
      const other = { ...context, [field]: 'other' };
      const cold = Option.getOrThrow(detailInput(other.legalEntityId, product.id, other, 7));
      expect(productDetailData.snapshot(cold)).toBe(pageDataPending);
      expect(renderProductState(cold.productId, other, 7)).toBe('loading');
    }
    expect(productDetailData.snapshot({ ...input, revision: 8 })).toBe(pageDataPending);
  }),
);

it.effect('forbidden refresh discards old fields/actions and a subsequent allowed opening retries', () =>
  Effect.gen(function* forbiddenRefresh() {
    yield* preloadProductDetails(context, 7, [product]);
    rstest.mocked(executeRecords).mockReturnValue(Effect.fail(denied));
    yield* productDetailData.refresh(input);
    expect(detailState(true, productDetailData.snapshot(input))).toEqual({ reason: 'forbidden', status: 'error' });
    expect(productDetailData.snapshot(input)).not.toHaveProperty('value');
    rstest.mocked(executeRecords).mockReturnValue(Effect.succeed(response));
    yield* productDetailData.read(input);
    expect(productDetailData.snapshot(input).state).toBe('ready');
  }),
);

it.effect('missing products are not filled from fixtures or retained as reusable negative cache hits', () =>
  Effect.gen(function* missingProduct() {
    const missing = Option.getOrThrow(detailInput(context.legalEntityId, 'missing', context, 7));
    yield* Effect.exit(productDetailData.read(missing));
    expect(detailState(true, productDetailData.snapshot(missing))).toEqual({ status: 'not-found' });
    yield* Effect.exit(productDetailData.read(missing));
    expect(executeRecords).toHaveBeenCalledTimes(2);
  }),
);

it.effect('native settled-write and live events invalidate details without requesting other pages', () =>
  Effect.gen(function* invalidationEvents() {
    yield* preloadProductDetails(context, 7, [product]);
    globalThis.dispatchEvent(new Event(moduleWriteEvent));
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
    yield* productDetailData.read(input);
    globalThis.dispatchEvent(new Event(moduleChangeEvent));
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
    expect(executeRecords).toHaveBeenCalledTimes(2);
  }),
);

it.effect('owner commands invalidate details but preserve the submitted expectedRevision and command outcome', () =>
  Effect.gen(function* ownerWrite() {
    yield* preloadProductDetails(context, 7, [product]);
    const commit = yield* Schema.decodeEffect(ApplyCommandResultSchema)({ entityIds: [product.id], revision: 8 });
    rstest.mocked(executeManageCatalog).mockReturnValue(Effect.succeed(commit));
    const done = yield* Deferred.make<CommandOutcome>();
    runCommand({ _tag: 'UpdateProduct', id: product.id, patch: { active: false } }, 7, (outcome) => {
      Deferred.doneUnsafe(done, Effect.succeed(outcome));
    });
    expect(yield* Deferred.await(done)).toEqual({ ok: true, revision: 8 });
    expect(rstest.mocked(executeManageCatalog).mock.calls[0]?.[0].expectedRevision).toBe(7);
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
  }),
);

it.effect('rejected owner commands also invalidate the local cache without altering their revision', () =>
  Effect.gen(function* rejectedWrite() {
    yield* preloadProductDetails(context, 7, [product]);
    const failure = yield* Schema.decodeEffect(ManageCatalogActionConflictProblemSchema)({
      _tag: 'ManageCatalogActionConflictProblem',
      code: 'merchandise_revision_conflict',
      detail: 'Changed',
      status: 409,
      title: 'Conflict',
      type: 'urn:test:conflict',
    });
    rstest.mocked(executeManageCatalog).mockReturnValue(Effect.fail(failure));
    const done = yield* Deferred.make<CommandOutcome>();
    runCommand({ _tag: 'UpdateProduct', id: product.id, patch: { active: false } }, 7, (outcome) => {
      Deferred.doneUnsafe(done, Effect.succeed(outcome));
    });
    expect(yield* Deferred.await(done)).toEqual({ ok: false, reason: 'conflict' });
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
  }),
);

it.effect('missing Shell identity never starts background detail reads', () =>
  Effect.gen(function* unknownScope() {
    yield* preloadProductDetails(undefined, 7, [product]);
    yield* prepareProductDetail({ routeParams: { id: product.id }, search: '?productRevision=7' });
    expect(executeRecords).not.toHaveBeenCalled();
    expect(productDetailSearch(undefined, 7)()).toEqual({});
  }),
);

it('revision hints are bounded cache keys, not a new write revision or an authorization bypass', () => {
  expect(productRevisionOf('?productRevision=7')).toBe(7);
  expect(productDetailSearch(context, 7)()).toEqual({ productRevision: 7 });
  for (const value of ['', '-1', '7.5', 'NaN', 'Infinity', '9007199254740992']) {
    expect(productRevisionOf(`?productRevision=${value}`)).toBeUndefined();
  }
  expect(productRevisionOf('')).toBeUndefined();
  expect(Option.isNone(detailInput(context.legalEntityId, '', context, 7))).toBe(true);
});

it('the list view key distinguishes current scope, filters, sort and page', () => {
  const first = { legalEntityId: context.legalEntityId, query: firstProductPage(50), scope: 'tenant-a/principal-a' };
  const key = productListData.key(first);
  expect(productListData.key({ ...first, scope: 'tenant-a/principal-b' })).not.toBe(key);
  expect(productListData.key({ ...first, query: { ...first.query, offset: 50 } })).not.toBe(key);
  expect(productListData.key({ ...first, query: { ...first.query, search: 'cable' } })).not.toBe(key);
});

it.effect('a product proposal retains actual pending metadata without reporting a committed revision', () =>
  Effect.gen(function* productProposal() {
    const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
      _tag: 'ActionProposalAccepted',
      expiresAt: '2026-11-10T12:00:00.000Z',
      proposalId: '60000000-0000-4000-8000-000000000001',
    });
    rstest.mocked(executeManageCatalog).mockReturnValue(Effect.succeed(receipt));
    const completion = yield* Deferred.make<CommandOutcome>();
    runCommand({ _tag: 'UpdateProduct', id: product.id, patch: { active: false } }, 7, (outcome) => {
      Deferred.doneUnsafe(completion, Effect.succeed(outcome));
    });
    const outcome = yield* Deferred.await(completion);
    expect(outcome).toEqual({ ok: false, proposal: receipt, reason: 'approval-required' });
    expect('revision' in outcome).toBe(false);
  }),
);
