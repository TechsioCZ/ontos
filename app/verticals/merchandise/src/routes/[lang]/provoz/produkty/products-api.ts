import { definePageData } from '@app/shared-contracts/page-data';
import type { PageDataSnapshot } from '@app/shared-contracts/page-data';
import { Effect, Match, Option, Random, Schema } from 'effect';
import type { Cause } from 'effect';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import { ProductIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductId, ProductRecord } from '../../../../../shared/domain/merchandise-model.ts';
import type {
  ProductCategoryCount,
  RecordsRequestEncoded,
  RecordsResponse,
  RecordsView,
} from '../../../../../shared/apis/records.ts';

/**
 * `conflict` is a stale revision (someone else changed the data); `rejected` is a business rule the
 * current state refuses, such as an issue larger than the stock on hand.
 */
const FailureReasonSchema = Schema.Literals([
  'conflict',
  'forbidden',
  'invalid',
  'rejected',
  'reload-required',
  'unavailable',
]);
export type FailureReason = typeof FailureReasonSchema.Type;

export type LoadOutcome =
  | { readonly ok: true; readonly response: RecordsResponse }
  | { readonly ok: false; readonly reason: FailureReason };

export type CommandOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: FailureReason };

type RecordsFailure = Effect.Error<ReturnType<typeof executeRecords>>;
type CommandFailure = Effect.Error<ReturnType<typeof executeApplyCommand>>;

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
    Match.tag(
      'GatewayReloadRequiredProblem',
      'DocumentCompositionRevisionError',
      (): FailureReason => 'reload-required',
    ),
    // The shell module-admission seam returns a plain-text 409, not the owner problem JSON.
    Match.tag('HttpClientError', (problem): FailureReason =>
      problem.response?.status === 409 && problem.request.url.includes('/module-api/')
        ? 'reload-required'
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
    Match.tag('ApplyCommandActionConflictProblem', (problem): FailureReason =>
      problem.code === 'merchandise_lifecycle_conflict' ? 'rejected' : 'conflict',
    ),
    Match.tag('ApplyCommandActionIneligibleProblem', (): FailureReason => 'rejected'),
    Match.tag(
      'ApplyCommandActionAuthenticationProblem',
      'ApplyCommandActionForbiddenProblem',
      (): FailureReason => 'forbidden',
    ),
    Match.tag('ApplyCommandActionInvalidProblem', (): FailureReason => 'invalid'),
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
export const productListView = (query: ProductListQuery): ViewPayload => ({
  limit: query.limit,
  offset: query.offset,
  ordersLimit: 0,
  summary: true,
  ...(query.search.trim() === '' ? {} : { search: query.search.trim() }),
  ...(query.categoryId === null ? {} : { categoryId: query.categoryId }),
  ...(query.category === null ? {} : { category: query.category }),
  ...(query.taggedIds === null ? {} : { taggedProductIds: [...query.taggedIds] }),
  ...(query.lowStockOnly ? { lowStockOnly: true } : {}),
  ...(query.sort === null ? {} : { productSort: query.sort }),
});

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
}

/** Everything `productListView` sends, in a fixed order: equal requests share one entry. */
const productListKey = ({ legalEntityId, query }: ProductListInput): string =>
  [
    legalEntityId,
    query.limit,
    query.offset,
    query.search.trim(),
    query.categoryId ?? '',
    query.category ?? '',
    query.lowStockOnly,
    query.sort ?? '',
    query.taggedIds === null ? '*' : query.taggedIds.join(','),
  ].join('|');

/** One page of the products list with the company indicators and the write capability. */
export const productListData = definePageData({
  key: productListKey,
  load: ({ query }: ProductListInput) => readView(productListView(query)),
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
  key: (legalEntityId: string) => legalEntityId,
  load: () =>
    readView({ includeProductCategories: true, limit: 0, ordersLimit: 0 }).pipe(
      Effect.map((response): CategoryChoices => ({
        hasTree: response.hasCategoryTree === true,
        labels: response.productCategories ?? [],
      })),
    ),
  runtime: browserRuntime,
});

/** One category with its content fields and history, plus the tree around it. */
export const loadCategoryDetail = (categoryId: string, onOutcome: (outcome: LoadOutcome) => void): void =>
  loadView({ categoryId, includeCategories: true, limit: 0, ordersLimit: 0 }, onOutcome);

const isProductId = Schema.is(ProductIdSchema);

export interface ProductDetailInput {
  readonly legalEntityId: string;
  readonly productId: ProductId;
}

export interface ProductDetail {
  /** None when the company has no product with this id. */
  readonly product: Option.Option<ProductRecord>;
  readonly response: RecordsResponse;
}

/** Detail read: one product with its variants, its own movements and the path label of its tree category. */
export const productDetailData = definePageData({
  key: ({ legalEntityId, productId }: ProductDetailInput) => `${legalEntityId}|${productId}`,
  load: ({ productId }: ProductDetailInput) =>
    readView({ categoryTrails: true, ordersLimit: 0, productId }).pipe(
      Effect.map((response): ProductDetail => ({
        product: Option.fromUndefinedOr(response.products.find((entry) => entry.id === productId)),
        response,
      })),
    ),
  runtime: browserRuntime,
});

/** One command against the single merchandise apply-command action. Each call gets its own idempotency key. */
export const runCommand = (
  command: MerchandiseCommand,
  expectedRevision: number,
  onOutcome: (outcome: CommandOutcome) => void,
): void => {
  void browserRuntime.runPromise(
    newId.pipe(
      Effect.flatMap((idempotencyKey) =>
        executeApplyCommand({ command, expectedRevision }, idempotencyKey, { idempotencyKey }),
      ),
      Effect.match({
        onFailure: (error): CommandOutcome => ({ ok: false, reason: commandReason(error) }),
        onSuccess: (result): CommandOutcome => ({ ok: true, revision: result.revision }),
      }),
      Effect.map(onOutcome),
    ),
  );
};

/** The detail input for a route id; none for an id no product can have. */
export const detailInput = (legalEntityId: string, routeId: string): Option.Option<ProductDetailInput> =>
  isProductId(routeId) ? Option.some({ legalEntityId, productId: routeId }) : Option.none();

export type ProductDetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'invalid' }
  | { readonly status: 'not-found' }
  | { readonly reason: FailureReason; readonly status: 'error' }
  | { readonly product: ProductRecord; readonly response: RecordsResponse; readonly status: 'ready' };

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
    return { reason: snapshot.error, status: 'error' };
  }
  const { product, response } = snapshot.value;
  return Option.match(product, {
    onNone: (): ProductDetailState => ({ status: 'not-found' }),
    onSome: (found): ProductDetailState => ({ product: found, response, status: 'ready' }),
  });
};

export const productNavigationFailureKey = Match.type<Cause.TimeoutError | Cause.UnknownError>().pipe(
  Match.tag('TimeoutError', () => 'messages.navigationTimeout'),
  Match.tag('UnknownError', () => 'messages.failed'),
  Match.exhaustive,
);
