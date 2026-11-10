import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { LIST_WARM_ROWS, makeIntentLimiter, makePointerDwell, rowIntentProps, useHeldSnapshot } from '@app/admin-ui';
import type { RowIntentProps } from '@app/admin-ui';
import { definePageData, pageDataPending, pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext, ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';
import type { TanstackTable } from '@techsio/ui-kit/organisms/data-table';
import { Effect, Match, Option, Random, Result, Schema } from 'effect';
import type { Cause } from 'effect';
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeManageCatalog } from '../../../../api/manage-catalog-action-client.ts';
import { executeManageMarkets } from '../../../../api/manage-markets-action-client.ts';
import { executeCleanupDemo } from '../../../../api/cleanup-demo-action-client.ts';
import { executeChangeProductImages } from '../../../../api/change-product-images-action-client.ts';
import { executeRecordStockMovement } from '../../../../api/record-stock-movement-action-client.ts';
import { committedResult } from '../../../../api/action-result.ts';
import { executeRecords } from '../../../../api/records-consumer.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useKeptDetail } from '../../../../runtime/kept-detail.ts';
import type { DetailRead } from '../../../../runtime/kept-detail.ts';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import { ProductIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductId, ProductRecord } from '../../../../../shared/domain/merchandise-model.ts';
import type {
  ProductCategoryCount,
  RecordsRequestEncoded,
  RecordsResponse,
  RecordsView,
} from '../../../../../shared/apis/records.ts';

const RELOAD_REQUIRED = 'reload-required';
const PRODUCT_MODULE = 'demo.merchandise';
const ProductCacheKey = Schema.fromJsonString(Schema.Array(Schema.String));
const cacheKey = (parts: readonly string[]): string => Result.getOrThrow(Schema.encodeResult(ProductCacheKey)(parts));

/**
 * `conflict` is a stale revision (someone else changed the data); `rejected` is a business rule the
 * current state refuses, such as an issue larger than the stock on hand.
 */
const FailureReasonSchema = Schema.Literals([
  'approval-required',
  'conflict',
  'forbidden',
  'invalid',
  'not-found',
  'rejected',
  RELOAD_REQUIRED,
  'unavailable',
]);
export type FailureReason = typeof FailureReasonSchema.Type;

export type LoadOutcome =
  | { readonly ok: true; readonly response: RecordsResponse }
  | { readonly ok: false; readonly reason: FailureReason };

export type CommandOutcome =
  | { readonly image?: string; readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly proposal?: ActionProposalAccepted; readonly reason: FailureReason };

type RecordsFailure = Effect.Error<ReturnType<typeof executeRecords>>;
type CommandFailure = Effect.Error<ReturnType<typeof submitProductCommand>>;

/** Effect-injected randomness for correlation and idempotency identifiers. */
const newId = Effect.map(
  Effect.all([Random.nextInt, Random.nextInt, Random.nextInt], { concurrency: 1 }),
  ([first, second, third]) => `merchandise:products:${first}:${second}:${third}`,
);

/** Keep release admission failures distinct from owner revision conflicts and ordinary network failures. */
export const recordsReason = (error: RecordsFailure): FailureReason =>
  Match.value(error).pipe(
    Match.tag('RecordsPolicyConflictProblem', (): FailureReason => 'conflict'),
    Match.tag('RecordsAuthenticationProblem', 'RecordsForbiddenProblem', (): FailureReason => 'forbidden'),
    Match.tag('RecordsInvalidProblem', 'RecordsPolicyProblem', (): FailureReason => 'invalid'),
    Match.tag('GatewayAuthenticationRequiredProblem', 'GatewayForbiddenProblem', (): FailureReason => 'forbidden'),
    Match.tag('GatewayAudienceInvalidProblem', (): FailureReason => 'invalid'),
    Match.tag('GatewayReloadRequiredProblem', 'DocumentCompositionRevisionError', (): FailureReason => RELOAD_REQUIRED),
    // The shell module-admission seam returns a plain-text 409, not the owner problem JSON.
    Match.tag('HttpClientError', (problem): FailureReason =>
      problem.response?.status === 409 && problem.request.url.includes('/module-api/')
        ? RELOAD_REQUIRED
        : 'unavailable',
    ),
    Match.tag(
      'RecordsNotFoundProblem',
      'RecordsUnavailableProblem',
      'RecordsInternalProblem',
      'GatewayRateLimitedProblem',
      'GatewayUnavailableProblem',
      'GatewayInternalProblem',
      'SchemaError',
      (): FailureReason => 'unavailable',
    ),
    Match.exhaustive,
  );

/** Maps the apply-command problems onto the UI outcomes. Anything unlisted reads as unavailable. */
const commandReason = (error: CommandFailure): FailureReason =>
  Match.value(error).pipe(
    Match.tag(
      'ApplyCommandActionConflictProblem',
      'ManageCatalogActionConflictProblem',
      'ManageMarketsActionConflictProblem',
      'CleanupDemoActionConflictProblem',
      'ChangeProductImagesActionConflictProblem',
      'RecordStockMovementActionConflictProblem',
      (problem): FailureReason => (problem.code === 'merchandise_lifecycle_conflict' ? 'rejected' : 'conflict'),
    ),
    Match.tag(
      'ApplyCommandActionIneligibleProblem',
      'ManageCatalogActionIneligibleProblem',
      'ManageMarketsActionIneligibleProblem',
      'CleanupDemoActionIneligibleProblem',
      'ChangeProductImagesActionIneligibleProblem',
      'RecordStockMovementActionIneligibleProblem',
      (): FailureReason => 'rejected',
    ),
    Match.tag(
      'ApplyCommandActionAuthenticationProblem',
      'ManageCatalogActionAuthenticationProblem',
      'ManageMarketsActionAuthenticationProblem',
      'CleanupDemoActionAuthenticationProblem',
      'ChangeProductImagesActionAuthenticationProblem',
      'RecordStockMovementActionAuthenticationProblem',
      'ApplyCommandActionForbiddenProblem',
      'ManageCatalogActionForbiddenProblem',
      'ManageMarketsActionForbiddenProblem',
      'CleanupDemoActionForbiddenProblem',
      'ChangeProductImagesActionForbiddenProblem',
      'RecordStockMovementActionForbiddenProblem',
      (): FailureReason => 'forbidden',
    ),
    Match.tag(
      'ApplyCommandActionInvalidProblem',
      'ManageCatalogActionInvalidProblem',
      'ManageMarketsActionInvalidProblem',
      'CleanupDemoActionInvalidProblem',
      'ChangeProductImagesActionInvalidProblem',
      'RecordStockMovementActionInvalidProblem',
      (): FailureReason => 'invalid',
    ),
    Match.orElse((): FailureReason => 'unavailable'),
  );

export type ProductSort = NonNullable<RecordsView['productSort']>;

/** What the products list asks the server for: filters, sort and one page. */
export interface ProductListQuery {
  /** A product category label (companies without a storefront tree). */
  readonly category: string | null;
  /** A storefront tree category (with its subcategories). */
  readonly categoryId: string | null;
  readonly limit: number;
  readonly lowStockOnly: boolean;
  readonly offset: number;
  readonly search: string;
  readonly sort: ProductSort | null;
  /** Ids of the products carrying the selected tag; null = no tag filter. */
  readonly taggedIds: readonly string[] | null;
}

type ViewPayload = NonNullable<RecordsRequestEncoded['view']>;

/** List rows only (no variants or histories) and no orders: one bounded page of the catalog. */
type ViewDraft = { -readonly [Key in keyof ViewPayload]: ViewPayload[Key] };
export const productListView = (query: ProductListQuery): ViewPayload => {
  const view: ViewDraft = { limit: query.limit, offset: query.offset, ordersLimit: 0, summary: true };
  if (query.search.trim() !== '') {
    view.search = query.search.trim();
  }
  if (query.categoryId !== null) {
    view.categoryId = query.categoryId;
  }
  if (query.category !== null) {
    view.category = query.category;
  }
  if (query.taggedIds !== null) {
    view.taggedProductIds = [...query.taggedIds];
  }
  if (query.lowStockOnly) {
    view.lowStockOnly = true;
  }
  if (query.sort !== null) {
    view.productSort = query.sort;
  }
  return view;
};

/** One records read; its failure already says what the page shows for it. */
const readView = (view: ViewPayload): Effect.Effect<RecordsResponse, FailureReason> =>
  newId.pipe(
    Effect.flatMap((correlation) => executeRecords({ view }, correlation)),
    Effect.mapError(recordsReason),
  );

const loadView = (view: ViewPayload, onOutcome: (outcome: LoadOutcome) => void): void => {
  void browserRuntime.runPromise(
    readView(view).pipe(
      Effect.match({
        onFailure: (reason): LoadOutcome => ({ ok: false, reason }),
        onSuccess: (response): LoadOutcome => ({ ok: true, response }),
      }),
      Effect.map(onOutcome),
    ),
  );
};

/** Input of the products list data: the company and one filtered, sorted page. */
export interface ProductListInput {
  readonly legalEntityId: string;
  readonly query: ProductListQuery;
  readonly scope?: string | undefined;
}

/** Everything `productListView` sends, in a fixed order: equal requests share one entry. */
const productListKey = ({ legalEntityId, query, scope }: ProductListInput): string =>
  cacheKey([
    legalEntityId,
    scope ?? '',
    String(query.limit),
    String(query.offset),
    query.search.trim(),
    query.categoryId ?? '',
    query.category ?? '',
    String(query.lowStockOnly),
    query.sort ?? '',
    query.taggedIds === null ? '*' : query.taggedIds.join(','),
  ]);

export const productScope = (context: ModulePageContext | undefined): string | undefined =>
  pageDataScopeKey(context, PRODUCT_MODULE);

export const productCategoryKey = (legalEntityId: string, context?: ModulePageContext): string =>
  productScope(context) ?? legalEntityId;

/** One page of the products list with the company indicators and the write capability. */
export const productListData = definePageData({
  changesFrom: ['merchandise'],
  key: productListKey,
  load: ({ query }: ProductListInput) => readView(productListView(query)),
  maxEntries: 16,
  retainStale: false,
  runtime: browserRuntime,
});

/** The page the products list opens with: no filters, default sort. */
export const firstProductPage = (limit: number): ProductListQuery => ({
  category: null,
  categoryId: null,
  limit,
  lowStockOnly: false,
  offset: 0,
  search: '',
  sort: null,
  taggedIds: null,
});

/** The storefront category tree (navigation fields only), without products or orders. */
export const loadCategoryTree = (onOutcome: (outcome: LoadOutcome) => void): void =>
  loadView({ includeCategories: true, limit: 0, ordersLimit: 0 }, onOutcome);

export interface CategoryChoices {
  /** The company has a storefront tree: the filter searches it on the server. */
  readonly hasTree: boolean;
  /** Distinct product category labels; the filter offers them when the company has no storefront tree. */
  readonly labels: readonly ProductCategoryCount[];
}

/**
 * The category filter's choices per company, without products or orders: whether the company has a storefront tree
 * (the filter then searches it on the server) and, without a tree, the distinct product category labels with counts.
 */
export const categoryChoicesData = definePageData({
  changesFrom: ['merchandise'],
  key: (legalEntityId: string) => legalEntityId,
  load: () =>
    readView({ includeProductCategories: true, limit: 0, ordersLimit: 0 }).pipe(
      Effect.map((response): CategoryChoices => ({
        hasTree: response.hasCategoryTree === true,
        labels: response.productCategories ?? [],
      })),
    ),
  maxEntries: 16,
  retainStale: false,
  runtime: browserRuntime,
});

/** One category with its content fields and history, plus the tree around it. */
export const loadCategoryDetail = (categoryId: string, onOutcome: (outcome: LoadOutcome) => void): void =>
  loadView({ categoryId, includeCategories: true, limit: 0, ordersLimit: 0 }, onOutcome);

const isProductId = Schema.is(ProductIdSchema);

export interface ProductDetailInput {
  readonly legalEntityId: string;
  readonly productId: ProductId;
  /** The owner revision of the authorized list page, never a substitute for the detail's returned revision. */
  readonly revision?: number | undefined;
  readonly scope?: string | undefined;
}

export interface ProductDetail {
  /** None when the company has no product with this id. */
  readonly product: Option.Option<ProductRecord>;
  readonly response: RecordsResponse;
}

/** The one existing governed read carries the product, variants/histories, ledger, category trail and admitted markets. */
const readProductDetail = ({ productId }: ProductDetailInput) =>
  readView({ categoryTrails: true, ordersLimit: 0, productId }).pipe(
    Effect.flatMap((response) => {
      const product = response.products.find((entry) => entry.id === productId);
      // Missing records are retryable on the next opening, not a successful reusable negative result.
      return product === undefined
        ? Effect.fail<FailureReason>('not-found')
        : Effect.succeed<ProductDetail>({ product: Option.some(product), response });
    }),
  );

export const productDetailData = definePageData({
  cancelWhenUnused: true,
  changesFrom: ['merchandise'],
  key: ({ legalEntityId, productId, revision, scope }: ProductDetailInput) =>
    cacheKey([scope ?? legalEntityId, productId, String(revision)]),
  load: readProductDetail,
  maxEntries: 256,
  retainStale: false,
  runtime: browserRuntime,
});

export type ProductCommand = Extract<
  MerchandiseCommand,
  {
    readonly _tag:
      | 'CreateProduct'
      | 'UpdateProduct'
      | 'ChangePrice'
      | 'BulkUpdateProducts'
      | 'CreateCategory'
      | 'UpdateCategory'
      | 'SetProductMarketOffer'
      | 'ConfigureMarket'
      | 'SetMarketProductOffers'
      | 'RemoveMarket'
      | 'ArchiveDemoProduct'
      | 'ChangeProductImages'
      | 'RecordStockMovement';
  }
>;

const submitProductCommand = (command: ProductCommand, expectedRevision: number, idempotencyKey: string) => {
  const options = { idempotencyKey };
  return Match.value(command).pipe(
    Match.tag('CreateProduct', (value) =>
      executeApplyCommand({ command: value, expectedRevision }, idempotencyKey, options),
    ),
    Match.tag('UpdateProduct', 'ChangePrice', 'BulkUpdateProducts', 'CreateCategory', 'UpdateCategory', (value) =>
      executeManageCatalog({ command: value, expectedRevision }, idempotencyKey, options),
    ),
    Match.tag('SetProductMarketOffer', 'ConfigureMarket', 'SetMarketProductOffers', 'RemoveMarket', (value) =>
      executeManageMarkets({ command: value, expectedRevision }, idempotencyKey, options),
    ),
    Match.tag('ArchiveDemoProduct', (value) =>
      executeCleanupDemo({ command: value, expectedRevision }, idempotencyKey, options),
    ),
    Match.tag('ChangeProductImages', (value) =>
      executeChangeProductImages({ command: value, expectedRevision }, idempotencyKey, options),
    ),
    Match.tag('RecordStockMovement', (value) =>
      executeRecordStockMovement({ command: value, expectedRevision }, idempotencyKey, options),
    ),
    Match.exhaustive,
    Effect.flatMap(committedResult),
  );
};

/**
 * One product command against `expectedRevision`, answered as a `CommandOutcome`; the product reads are invalidated.
 * The product workflow uses each published closed operation, with one native idempotency key per attempt.
 */
export const productCommandOutcome = (
  command: ProductCommand,
  expectedRevision: number,
): Effect.Effect<CommandOutcome> =>
  newId.pipe(
    Effect.flatMap((idempotencyKey) =>
      submitProductCommand(command, expectedRevision, idempotencyKey).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            productListData.invalidate();
            productDetailData.invalidate();
            categoryChoicesData.invalidate();
          }),
        ),
      ),
    ),
    Effect.match({
      onFailure: (error): CommandOutcome =>
        Schema.is(ActionProposalAcceptedSchema)(error)
          ? { ok: false, proposal: error, reason: 'approval-required' }
          : { ok: false, reason: commandReason(error) },
      onSuccess: (result): CommandOutcome =>
        result.image === undefined
          ? { ok: true, revision: result.revision }
          : { image: result.image, ok: true, revision: result.revision },
    }),
  );

export const runCommand = (
  command: ProductCommand,
  expectedRevision: number,
  onOutcome: (outcome: CommandOutcome) => void,
): void => {
  void browserRuntime.runPromise(productCommandOutcome(command, expectedRevision).pipe(Effect.map(onOutcome)));
};

/** The detail input for a route id; none for an id no product can have. */
export const detailInput = (
  legalEntityId: string,
  routeId: string,
  context?: ModulePageContext,
  revision?: number,
): Option.Option<ProductDetailInput> => {
  if (!isProductId(routeId)) {
    return Option.none();
  }
  const scope = productScope(context);
  const input: { -readonly [Key in keyof ProductDetailInput]: ProductDetailInput[Key] } = {
    legalEntityId,
    productId: routeId,
  };
  if (scope !== undefined) {
    input.scope = scope;
  }
  if (revision !== undefined) {
    input.revision = revision;
  }
  return Option.some(input);
};

const ProductRouteSearch = Schema.toCodecJson(
  Schema.fromURLSearchParams(
    Schema.Struct({
      productRevision: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u))),
    }),
  ),
);

/** A navigation cache hint, not authorization or the revision submitted by a mutation. Invalid hints read cold. */
const ProductRevision = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const productRevisionOf = (search: string): number | undefined => {
  const revision = Option.getOrUndefined(Schema.decodeOption(ProductRouteSearch)(search))?.productRevision;
  return revision === undefined ? undefined : Option.getOrUndefined(Schema.decodeOption(ProductRevision)(revision));
};

export const productDetailSearch = (context: ModulePageContext | undefined, revision: number) => {
  if (productScope(context) === undefined) {
    return () => ({});
  }
  return () => ({ productRevision: revision });
};

/** Shell preparation and the mounted page resolve the exact same scoped, revision-qualified entry. */
export const prepareProductDetail = (props: ModulePageProps): Effect.Effect<void> =>
  Option.match(
    detailInput(
      props.context?.legalEntityId ?? '',
      props.routeParams['id'] ?? '',
      props.context,
      productRevisionOf(props.search),
    ),
    {
      onNone: () => Effect.void,
      onSome: (input) => (input.scope === undefined ? Effect.void : productDetailData.read(input).pipe(Effect.ignore)),
    },
  );

export interface ProductRowModel {
  readonly getRowModel: () => { readonly rows: readonly { readonly original: ProductRecord }[] };
}

/** The installed kit's final row model, fenced against an obsolete server page or scope. */
export const currentProductRows = (
  table: ProductRowModel | undefined,
  authorizedRows: readonly ProductRecord[],
): readonly ProductRecord[] => {
  const rows = table?.getRowModel().rows.map((row) => row.original) ?? [];
  const authorized = new Set(authorizedRows);
  return rows.length <= 200 && rows.every((row) => authorized.has(row)) ? rows : [];
};

export const preloadProductDetails = (
  context: ModulePageContext | undefined,
  revision: number,
  rows: readonly ProductRecord[],
): Effect.Effect<void> =>
  productScope(context) === undefined
    ? Effect.void
    : Effect.forEach(
        rows.slice(0, LIST_WARM_ROWS),
        (row) =>
          Option.match(detailInput(context?.legalEntityId ?? '', row.id, context, revision), {
            onNone: () => Effect.void,
            onSome: (input) => productDetailData.read(input).pipe(Effect.ignore),
          }),
        { concurrency: 2, discard: true },
      );

/**
 * Warms the first `LIST_WARM_ROWS` final current-page rows; every other row is warmed by its intent. Changing
 * page/filter/scope cancels the previous batch and queue.
 */
export const useProductDetailsPrefetch = (
  context: ModulePageContext | undefined,
  revision: number,
  viewKey: string,
  table: TanstackTable<ProductRecord> | undefined,
  authorizedRows: readonly ProductRecord[],
  enabled: boolean,
): void => {
  const scope = productScope(context);
  const request = cacheKey([scope ?? '', String(revision), viewKey, String(enabled)]);
  // Observe the kit's external store. React checks this scalar snapshot after controlled child data commits.
  // Row identity fencing rejects the previous server page until the kit has consumed the new source rows.
  const modelKey = useSyncExternalStore(
    (listener) => {
      const pagination = table?.atoms.pagination.subscribe(listener);
      const sorting = table?.atoms.sorting.subscribe(listener);
      return () => {
        pagination?.unsubscribe();
        sorting?.unsubscribe();
      };
    },
    () => cacheKey(currentProductRows(table, authorizedRows).map((row) => row.id)),
    () => '[]',
  );
  const currentRows = currentProductRows(table, authorizedRows);
  const rows = enabled && cacheKey(currentRows.map((row) => row.id)) === modelKey ? currentRows : [];
  const selection = cacheKey(rows.map((row) => row.id));
  const needsPreload = useSyncExternalStore(
    productDetailData.subscribe,
    () =>
      scope !== undefined &&
      rows.slice(0, LIST_WARM_ROWS).some((row) =>
        Option.match(detailInput(context?.legalEntityId ?? '', row.id, context, revision), {
          onNone: () => false,
          onSome: (input) => productDetailData.snapshot(input).state !== 'ready',
        }),
      ),
    () => false,
  );
  // One batch per list revision and page of rows. The strict detail entries read as pending again once their 20 s
  // freshness window passes or a live change from any module arrives; warming every row again then made an idle list
  // re-read all its details every 40 s and on every live event. A write or a change of these products moves the
  // revision and warms the rows again; opening a row always reads its detail fresh.
  const batch = cacheKey([request, selection]);
  const warmed = useRef<string>(undefined);
  const preload = useEffectEvent((key: string) =>
    key === request
      ? preloadProductDetails(context, revision, rows).pipe(
          Effect.andThen(
            Effect.sync(() => {
              warmed.current = batch;
            }),
          ),
        )
      : Effect.void,
  );
  useEffect(() => {
    const fiber =
      needsPreload && scope !== undefined && selection !== '[]' && warmed.current !== batch
        ? browserRuntime.runFork(preload(request))
        : undefined;
    return () => {
      fiber?.interruptUnsafe();
    };
  }, [batch, needsPreload, request, scope, selection]);
};

const productIntentReads = makeIntentLimiter();
const productPointerDwell = makePointerDwell((effect) => browserRuntime.runFork(effect));

/**
 * Warms one row's detail when the user shows the intent to open it. The strict detail store does the rest: a fresh
 * entry answers at once without a request and a running read is joined, so each row has at most one read in flight.
 * At most two intent reads run at once; a sweep over many rows keeps only the newest waiting.
 */
export const prefetchProductDetail = (
  context: ModulePageContext | undefined,
  revision: number,
  productId: string,
): void => {
  if (productScope(context) === undefined) {
    return;
  }
  const input = Option.getOrUndefined(detailInput(context?.legalEntityId ?? '', productId, context, revision));
  if (input === undefined || productDetailData.snapshot(input).state === 'ready') {
    return;
  }
  productIntentReads((done) => {
    if (productDetailData.snapshot(input).state === 'ready') {
      done();
      return;
    }
    browserRuntime.runFork(productDetailData.read(input).pipe(Effect.ignore, Effect.ensuring(Effect.sync(done))));
  });
};

/** Intent prefetch of the products list: the row the user points at or focuses has its detail ready to open. */
export const productDetailIntent = (
  context: ModulePageContext | undefined,
  revision: number,
  table: ProductRowModel | undefined,
  authorizedRows: readonly ProductRecord[],
  enabled: boolean,
): RowIntentProps =>
  rowIntentProps((index) => {
    const row = enabled ? currentProductRows(table, authorizedRows)[index] : undefined;
    if (row !== undefined) {
      prefetchProductDetail(context, revision, row.id);
    }
  }, productPointerDwell);

export type ProductDetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'invalid' }
  | { readonly status: 'not-found' }
  | { readonly reason: FailureReason; readonly status: 'error' }
  | {
      readonly product: ProductRecord;
      /** The product shown is the last one read: reading it again failed for this reason. */
      readonly reloadFailure?: FailureReason;
      readonly response: RecordsResponse;
      readonly status: 'ready';
    };

export const detailState = (
  valid: boolean,
  snapshot: PageDataSnapshot<ProductDetail, FailureReason>,
): ProductDetailState => {
  if (!valid) {
    return { status: 'invalid' };
  }
  if (snapshot.state === 'pending') {
    return { status: 'loading' };
  }
  if (snapshot.state === 'failed') {
    if (snapshot.error === 'not-found') {
      return { status: 'not-found' };
    }
    return { reason: snapshot.error, status: 'error' };
  }
  const { product, response } = snapshot.value;
  return Option.match(product, {
    onNone: (): ProductDetailState => ({ status: 'not-found' }),
    onSome: (found): ProductDetailState => ({ product: found, response, status: 'ready' }),
  });
};

type ReadyProductDetail = Extract<ProductDetailState, { readonly status: 'ready' }>;

/** A denied read never keeps the shown product: its fields and actions go at once. */
const productRead = (state: ProductDetailState): DetailRead<ReadyProductDetail, FailureReason> => {
  if (state.status === 'ready') {
    return { kind: 'ready', ready: state };
  }
  if (state.status === 'loading') {
    return { kind: 'loading' };
  }
  return state.status === 'error' && state.reason !== 'forbidden'
    ? { failure: state.reason, kind: 'failed' }
    : { kind: 'final' };
};

/** A warmed complete scoped entry is consumed in render. Missing Shell identity never reuses the detail store. */
export const useProductDetail = (
  legalEntityId: string,
  routeId: string,
  context?: ModulePageContext,
  revision?: number,
  refreshVersion = 0,
): ProductDetailState => {
  const scope = productScope(context);
  const input = detailInput(legalEntityId, routeId, context, revision);
  const snapshot = useSyncExternalStore(
    (listener) =>
      productDetailData.subscribe(listener, scope !== undefined && Option.isSome(input) ? input.value : undefined),
    () => (scope !== undefined && Option.isSome(input) ? productDetailData.snapshot(input.value) : pageDataPending),
    () => pageDataPending,
  );
  const request = cacheKey([legalEntityId, routeId, scope ?? '', String(revision), String(refreshVersion)]);
  const [unscoped, setUnscoped] = useState<{
    readonly key: string;
    readonly snapshot: PageDataSnapshot<ProductDetail, FailureReason>;
  }>();
  const load = useEffectEvent((key: string) =>
    key === request
      ? Option.match(input, {
          onNone: () => Effect.void,
          onSome: (current) =>
            scope === undefined
              ? readProductDetail(current).pipe(
                  Effect.match({
                    onFailure: (error) =>
                      setUnscoped({ key: request, snapshot: { error, refreshing: false, state: 'failed' } }),
                    onSuccess: (value) =>
                      setUnscoped({ key: request, snapshot: { refreshing: false, state: 'ready', value } }),
                  }),
                )
              : productDetailData.read(current).pipe(Effect.ignore),
        })
      : Effect.void,
  );
  useEffect(() => {
    const fiber = browserRuntime.runFork(load(request));
    return () => fiber.interruptUnsafe();
  }, [request]);
  // The strict store reads as pending while it reloads this same record (freshness window, live change, own write).
  // The held snapshot keeps the detail mounted until the reload settles; another key or a failure never reuses it.
  const shown = useHeldSnapshot(
    Option.isSome(input) ? productDetailData.key(input.value) : '',
    scope === undefined ? pageDataPending : snapshot,
  );
  const state =
    scope === undefined
      ? detailState(Option.isSome(input), unscoped?.key === request ? unscoped.snapshot : pageDataPending)
      : detailState(Option.isSome(input), shown);
  // A failed reload of the product already on screen keeps it, so the editor and its unsaved drafts stay.
  const kept = useKeptDetail({
    key: cacheKey([legalEntityId, scope ?? '', routeId]),
    read: productRead(state),
    same: (left, right) => left.product === right.product && left.response === right.response,
  });
  if (kept === null) {
    return state;
  }
  return kept.reloadFailure === undefined ? kept.ready : { ...kept.ready, reloadFailure: kept.reloadFailure };
};

export const productNavigationFailureKey = Match.type<Cause.TimeoutError | Cause.UnknownError>().pipe(
  Match.tag('TimeoutError', () => 'messages.navigationTimeout'),
  Match.tag('UnknownError', () => 'messages.failed'),
  Match.exhaustive,
);
