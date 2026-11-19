// @rstest-environment happy-dom
import { GatewayContextApi, shellGatewayContextContract } from '@app/shared-contracts';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { Deferred, Effect, Fiber, Layer, Option, Schema } from 'effect';
import { unmountAll } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
  streamingBrowserNetwork,
} from '@app/shared-contracts/testing/http-double';
import { HttpApi } from 'effect/http-api';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { mountInRoute } from '../support/module-ui.ts';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import { createElement } from 'react';
import { moduleChangeEvent, moduleWriteEvent, pageDataPending } from '@app/shared-contracts/page-data';
import { RecordsApi, RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import {
  ManageCatalogActionApi,
  ManageCatalogActionConflictProblemSchema,
} from '../../shared/apis/manage-catalog-action.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import type { ProductRecord, RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/actions/manage-catalog.ts';
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

const reads: RecordsRequest[] = [];
const commands: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
let readAnswer: (payload: RecordsRequest) => Effect.Effect<RecordsResponse, typeof denied>;
let commandAnswer: Effect.Effect<
  typeof ApplyCommandResultSchema.Type | typeof ActionProposalAcceptedSchema.Type,
  typeof ManageCatalogActionConflictProblemSchema.Type
> = Effect.never;
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const OwnerActionApi = ManageCatalogActionApi.prefix('/merchandise-api');
const applications = [
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.push(payload);
          return readAnswer(payload);
        }),
      ),
    ),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          return commandAnswer;
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
] as const;
const network = browserNetwork(...applications);
/** The same servers, with the window request's abort reaching its handler, as a dropped connection does. */
const cancellationNetwork = streamingBrowserNetwork(...applications);

/** Holds the first row's actual gateway prerequisite, before its Records request can be sent. */
const Gateway = HttpApi.make('productPreloadIssuer')
  .add(GatewayContextApi.groups.gatewayContext)
  .prefix(shellGatewayContextContract.apiPrefix);
const delayedFirstGateway = (waiting: Deferred.Deferred<boolean>, release: Deferred.Deferred<boolean>) => {
  let issued = 0;
  return serveApi(
    Gateway,
    HttpApiBuilder.group(Gateway, 'gatewayContext', (group) =>
      group
        .handle('issueGatewayContext', ({ payload }) =>
          Effect.gen(function* issueAfterPrerequisite() {
            issued += 1;
            const token = `merchandise-assertion-${issued}`;
            if (issued === 1) {
              yield* Deferred.succeed(waiting, true);
              yield* Deferred.await(release);
            }
            return {
              apiBaseUrl: '/merchandise-api',
              compositionRevision: payload.compositionRevision,
              expiresAt: 2_147_483_647,
              token,
            };
          }),
        )
        .handle('issueApiKeyGatewayContext', () => Effect.die('Browser reads never issue API-key contexts'))
        .handle('issueDelegatedGatewayContext', () => Effect.die('Browser reads never issue delegated contexts')),
    ),
  );
};

beforeEach(() => {
  reads.length = 0;
  commands.length = 0;
  productListData.invalidate();
  productDetailData.invalidate();
  readAnswer = ({ view }) =>
    Effect.succeed({
      ...response,
      products: products.filter((entry) => entry.id === view?.productId),
    });
  commandAnswer = Effect.never;
});
afterEach(unmountAll);

const StateProbe = ({
  id,
  revision,
  scope,
}: {
  readonly id: string;
  readonly revision: number;
  readonly scope: typeof context;
}) => createElement('output', null, useProductDetail(scope.legalEntityId, id, scope, revision).status);

const renderProductState = (id: string, scope: typeof context, revision: number) =>
  Effect.gen(function* renderState() {
    yield* mountInRoute(createElement(StateProbe, { id, revision, scope }));
    const state = document.querySelector('output')?.textContent;
    unmountAll();
    return state;
  });

it.live(
  'a warmed product opens with complete base, variants, histories, ledger, category and admitted markets without a request',
  () =>
    Effect.gen(function* warmOpen() {
      yield* pinTestDocument;
      yield* preloadProductDetails(context, 7, [product]);
      yield* networkIdle;
      expect(reads).toHaveLength(1);
      expect(reads[0]).toEqual({
        view: { categoryTrails: true, ordersLimit: 0, productId: product.id },
      });
      const cached = productDetailData.snapshot(input);
      expect(cached.state).toBe('ready');
      reads.length = 0;
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
      yield* mountInRoute(createElement(ProductProbe));
      expect(document.querySelector('output')?.outerHTML).toBe(
        '<output>Cable 1|BLACK|1|receipt-1|Electronics / Cables|AKROS-SK|7</output>',
      );
      expect(productDetailData.snapshot(input)).toBe(cached);
      yield* networkIdle;
      expect(reads).toHaveLength(0);
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(network)),
);

it.live.each([false, true])(
  'prefetch uses final kit rows regardless of HTTP delivery order (overtake: %s)',
  (overtake) =>
    Effect.gen(function* finalRowModel() {
      yield* pinTestDocument;
      const final: ProductRecord[] = [];
      for (const row of products.slice(2, 4)) {
        final.unshift(row);
      }
      const table = { getRowModel: () => ({ rows: final.map((original) => ({ original })) }) };
      const rows = currentProductRows(table, products);
      expect(rows).toEqual(final);
      const [first, second] = rows;
      if (first === undefined || second === undefined) {
        throw new Error('Two final rows required');
      }
      const release = yield* Deferred.make<boolean>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, true));
      const firstWaiting = yield* Deferred.make<boolean>();
      const secondDelivered = yield* Deferred.make<boolean>();
      const answer = readAnswer;
      readAnswer = (payload) =>
        payload.view?.productId === second.id
          ? Deferred.succeed(secondDelivered, true).pipe(Effect.andThen(answer(payload)))
          : answer(payload);
      const deliveryNetwork = browserNetwork(
        delayedFirstGateway(firstWaiting, release),
        applications[1],
        applications[2],
      );
      yield* Effect.gen(function* deliveredRows() {
        if (!overtake) {
          yield* Deferred.succeed(release, true);
        }
        // In the overtake control only, start this row alone so the held issuer request is unambiguously
        // its prerequisite. The ordinary case starts both rows solely through the real batch.
        const firstInput = Option.getOrThrow(detailInput(context.legalEntityId, first.id, context, 7));
        const firstRead = overtake ? yield* productDetailData.read(firstInput).pipe(Effect.forkChild) : undefined;
        if (overtake) {
          yield* Deferred.await(firstWaiting);
        }
        const warming = yield* preloadProductDetails(context, 7, rows).pipe(Effect.forkChild);
        if (overtake) {
          yield* Deferred.await(secondDelivered);
          expect(reads).toEqual([{ view: { categoryTrails: true, ordersLimit: 0, productId: second.id } }]);
        }
        yield* Deferred.succeed(release, true);
        if (firstRead !== undefined) {
          yield* Fiber.join(firstRead);
        }
        yield* Fiber.join(warming);
        yield* networkIdle;
        const expected = final.map((row) => ({ view: { categoryTrails: true, ordersLimit: 0, productId: row.id } }));
        expect(reads).toHaveLength(expected.length);
        expect(reads).toEqual(expect.arrayContaining(expected));
        expect(currentProductRows(table, products)).toEqual(final);
        expect(commands).toHaveLength(0);
      }).pipe(Effect.provide(deliveryNetwork));
    }),
);

it.live('warming preserves read-only capabilities without requesting mutations or wider catalog data', () =>
  Effect.gen(function* readOnlyProduct() {
    yield* pinTestDocument;
    const readOnly = {
      ...response,
      canManageCatalog: false,
      canManageMarkets: false,
      canWrite: false,
      productMarkets: [],
    };
    readAnswer = () => Effect.succeed(readOnly);
    yield* preloadProductDetails(context, 7, [product]);
    const detail = yield* productDetailData.read(input);
    expect(detail.response.canWrite).toBe(false);
    expect(detail.response.canManageCatalog).toBe(false);
    expect(detail.response.canManageMarkets).toBe(false);
    expect(detail.response.productMarkets).toEqual([]);
    expect(reads[0]).toEqual({
      view: { categoryTrails: true, ordersLimit: 0, productId: product.id },
    });
    yield* networkIdle;
    expect(reads).toHaveLength(1);
    expect(commands).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('an obsolete table model cannot prefetch a new source page or scope', () =>
  Effect.gen(function* obsoleteModel() {
    yield* pinTestDocument;
    const old = { getRowModel: () => ({ rows: [{ original: product }] }) };
    const nextSource = products.map((entry) => ({ ...entry }));
    expect(currentProductRows(old, nextSource)).toEqual([]);
    yield* preloadProductDetails(context, 7, currentProductRows(old, nextSource));
    yield* networkIdle;
    expect(reads).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('two background requests at most; cancelling a page stops its active requests and queued rows', () =>
  Effect.gen(function* cancellation() {
    yield* pinTestDocument;
    const started = yield* Deferred.make<true>();
    const stopped = yield* Deferred.make<true>();
    let active = 0;
    let peak = 0;
    readAnswer = () =>
      Effect.sync(() => {
        active += 1;
        peak = Math.max(peak, active);
      }).pipe(
        Effect.andThen(Effect.suspend(() => (active === 2 ? Deferred.succeed(started, true) : Effect.void))),
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            active -= 1;
          }).pipe(Effect.andThen(Effect.suspend(() => (active === 0 ? Deferred.succeed(stopped, true) : Effect.void)))),
        ),
      );
    const background = yield* Effect.forkChild(preloadProductDetails(context, 7, products));
    yield* Deferred.await(started);
    // Only the two held reads are open and nothing else is on its way: a third concurrent read would have arrived.
    yield* networkQuietExcept(2);
    expect(active).toBe(2);
    expect(peak).toBe(2);
    yield* Fiber.interrupt(background);
    yield* Deferred.await(stopped);
    expect(active).toBe(0);
    yield* networkIdle;
    expect(reads).toHaveLength(2);
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
  }).pipe(Effect.provide(cancellationNetwork)),
);

it.live('a foreground opening joins the row in flight and keeps it alive when the old table batch is cancelled', () =>
  Effect.gen(function* foregroundJoin() {
    yield* pinTestDocument;
    const started = yield* Deferred.make<true>();
    const gate = yield* Deferred.make<true>();
    readAnswer = () => Deferred.succeed(started, true).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(response));
    const background = yield* Effect.forkChild(preloadProductDetails(context, 7, [product]));
    yield* Deferred.await(started);
    const foreground = yield* Effect.forkChild(productDetailData.read(input));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(background);
    yield* Deferred.succeed(gate, true);
    yield* Fiber.join(foreground);
    yield* networkIdle;
    expect(reads).toHaveLength(1);
    expect(productDetailData.snapshot(input).state).toBe('ready');
  }).pipe(Effect.provide(network)),
);

it.live('foreground work bypasses two unrelated background rows', () =>
  Effect.gen(function* foregroundPriority() {
    yield* pinTestDocument;
    const started = yield* Deferred.make<true>();
    const thirdStarted = yield* Deferred.make<true>();
    readAnswer = () => {
      if (reads.length === 3) {
        return Deferred.succeed(thirdStarted, true).pipe(Effect.andThen(Effect.never));
      }
      if (reads.length === 2) {
        return Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never));
      }
      return Effect.never;
    };
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
    yield* Deferred.await(thirdStarted);
    yield* networkQuietExcept(3);
    expect(reads).toHaveLength(3);
    yield* Fiber.interrupt(foreground);
    yield* Fiber.interrupt(background);
  }).pipe(Effect.provide(network)),
);

it.live('full tenant, company, principal and owner revision isolate cached products', () =>
  Effect.gen(function* identity() {
    yield* pinTestDocument;
    yield* preloadProductDetails(context, 7, [product]);
    for (const field of ['tenantId', 'legalEntityId', 'principalId'] as const) {
      const other = { ...context, [field]: 'other' };
      const cold = Option.getOrThrow(detailInput(other.legalEntityId, product.id, other, 7));
      expect(productDetailData.snapshot(cold)).toBe(pageDataPending);
      readAnswer = () => Effect.never;
      expect(yield* renderProductState(cold.productId, other, 7)).toBe('loading');
    }
    expect(productDetailData.snapshot({ ...input, revision: 8 })).toBe(pageDataPending);
  }).pipe(Effect.provide(network)),
);

it.live('forbidden refresh discards old fields/actions and a subsequent allowed opening retries', () =>
  Effect.gen(function* forbiddenRefresh() {
    yield* pinTestDocument;
    yield* preloadProductDetails(context, 7, [product]);
    readAnswer = () => Effect.fail(denied);
    yield* productDetailData.refresh(input);
    expect(detailState(true, productDetailData.snapshot(input))).toEqual({ reason: 'forbidden', status: 'error' });
    expect(productDetailData.snapshot(input)).not.toHaveProperty('value');
    readAnswer = () => Effect.succeed(response);
    yield* productDetailData.read(input);
    expect(productDetailData.snapshot(input).state).toBe('ready');
  }).pipe(Effect.provide(network)),
);

it.live('missing products are not filled from fixtures or retained as reusable negative cache hits', () =>
  Effect.gen(function* missingProduct() {
    yield* pinTestDocument;
    const missing = Option.getOrThrow(detailInput(context.legalEntityId, 'missing', context, 7));
    yield* Effect.exit(productDetailData.read(missing));
    expect(detailState(true, productDetailData.snapshot(missing))).toEqual({ status: 'not-found' });
    yield* Effect.exit(productDetailData.read(missing));
    yield* networkIdle;
    expect(reads).toHaveLength(2);
  }).pipe(Effect.provide(network)),
);

it.live('native settled-write and live events invalidate details without requesting other pages', () =>
  Effect.gen(function* invalidationEvents() {
    yield* pinTestDocument;
    yield* preloadProductDetails(context, 7, [product]);
    window.dispatchEvent(new Event(moduleWriteEvent));
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
    yield* productDetailData.read(input);
    window.dispatchEvent(new Event(moduleChangeEvent));
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
    yield* networkIdle;
    expect(reads).toHaveLength(2);
  }).pipe(Effect.provide(network)),
);

it.live('owner commands invalidate details but preserve the submitted expectedRevision and command outcome', () =>
  Effect.gen(function* ownerWrite() {
    yield* pinTestDocument;
    yield* preloadProductDetails(context, 7, [product]);
    const commit = yield* Schema.decodeEffect(ApplyCommandResultSchema)({ entityIds: [product.id], revision: 8 });
    commandAnswer = Effect.succeed(commit);
    const done = yield* Deferred.make<CommandOutcome>();
    runCommand({ _tag: 'UpdateProduct', id: product.id, patch: { active: false } }, 7, (outcome) => {
      Deferred.doneUnsafe(done, Effect.succeed(outcome));
    });
    expect(yield* Deferred.await(done)).toEqual({ ok: true, revision: 8 });
    expect(commands[0]?.expectedRevision).toBe(7);
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
  }).pipe(Effect.provide(network)),
);

it.live('rejected owner commands also invalidate the local cache without altering their revision', () =>
  Effect.gen(function* rejectedWrite() {
    yield* pinTestDocument;
    yield* preloadProductDetails(context, 7, [product]);
    const failure = yield* Schema.decodeEffect(ManageCatalogActionConflictProblemSchema)({
      _tag: 'ManageCatalogActionConflictProblem',
      code: 'merchandise_revision_conflict',
      detail: 'Changed',
      status: 409,
      title: 'Conflict',
      type: 'urn:test:conflict',
    });
    commandAnswer = Effect.fail(failure);
    const done = yield* Deferred.make<CommandOutcome>();
    runCommand({ _tag: 'UpdateProduct', id: product.id, patch: { active: false } }, 7, (outcome) => {
      Deferred.doneUnsafe(done, Effect.succeed(outcome));
    });
    expect(yield* Deferred.await(done)).toEqual({ ok: false, reason: 'conflict' });
    expect(productDetailData.snapshot(input)).toBe(pageDataPending);
  }).pipe(Effect.provide(network)),
);

it.live('missing Shell identity never starts background detail reads', () =>
  Effect.gen(function* unknownScope() {
    yield* pinTestDocument;
    yield* preloadProductDetails(undefined, 7, [product]);
    yield* prepareProductDetail({ routeParams: { id: product.id }, search: '?productRevision=7' });
    yield* networkIdle;
    expect(reads).toHaveLength(0);
    expect(productDetailSearch(undefined, 7)()).toEqual({});
  }).pipe(Effect.provide(network)),
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

it.live('a product proposal retains actual pending metadata without reporting a committed revision', () =>
  Effect.gen(function* productProposal() {
    yield* pinTestDocument;
    const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
      _tag: 'ActionProposalAccepted',
      expiresAt: '2026-11-10T12:00:00.000Z',
      proposalId: '60000000-0000-4000-8000-000000000001',
    });
    commandAnswer = Effect.succeed(receipt);
    const completion = yield* Deferred.make<CommandOutcome>();
    runCommand({ _tag: 'UpdateProduct', id: product.id, patch: { active: false } }, 7, (outcome) => {
      Deferred.doneUnsafe(completion, Effect.succeed(outcome));
    });
    const outcome = yield* Deferred.await(completion);
    expect(outcome).toEqual({ ok: false, proposal: receipt, reason: 'approval-required' });
    expect('revision' in outcome).toBe(false);
  }).pipe(Effect.provide(network)),
);
