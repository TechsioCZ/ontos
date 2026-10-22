import { Effect, Match, Random, Schema } from 'effect';
import type { Cause } from 'effect';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import { ProductIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductRecord } from '../../../../../shared/domain/merchandise-model.ts';
import type { RecordsRequestEncoded, RecordsResponse, RecordsView } from '../../../../../shared/apis/records.ts';

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

const loadView = (view: ViewPayload, onOutcome: (outcome: LoadOutcome) => void): void => {
  void browserRuntime.runPromise(
    newId.pipe(
      Effect.flatMap((correlation) => executeRecords({ view }, correlation)),
      Effect.match({
        onFailure: (error): LoadOutcome => ({ ok: false, reason: recordsReason(error) }),
        onSuccess: (response): LoadOutcome => ({ ok: true, response }),
      }),
      Effect.map(onOutcome),
    ),
  );
};

/** One page of the products list with the company indicators and the write capability. */
export const loadProducts = (query: ProductListQuery, onOutcome: (outcome: LoadOutcome) => void): void =>
  loadView(productListView(query), onOutcome);

/** The storefront category tree (navigation fields only), without products or orders. */
export const loadCategoryTree = (onOutcome: (outcome: LoadOutcome) => void): void =>
  loadView({ includeCategories: true, limit: 0, ordersLimit: 0 }, onOutcome);

/**
 * The category filter's choices without products or orders: the storefront category tree (navigation fields only)
 * and the distinct product category labels with counts, for companies without a tree.
 */
export const loadCategoryChoices = (onOutcome: (outcome: LoadOutcome) => void): void =>
  loadView({ includeCategories: true, includeProductCategories: true, limit: 0, ordersLimit: 0 }, onOutcome);

/** One category with its content fields and history, plus the tree around it. */
export const loadCategoryDetail = (categoryId: string, onOutcome: (outcome: LoadOutcome) => void): void =>
  loadView({ categoryId, includeCategories: true, limit: 0, ordersLimit: 0 }, onOutcome);

/** Detail read: one product with its variants, its own movements and the storefront category tree. */
export const loadProductDetail = (productId: string, onOutcome: (outcome: LoadOutcome) => void): void =>
  loadView({ includeCategories: true, ordersLimit: 0, productId }, onOutcome);

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

export type ProductDetailSnapshot =
  | { readonly status: 'loading' }
  | { readonly status: 'invalid' }
  | { readonly status: 'not-found' }
  | { readonly reason: FailureReason; readonly status: 'error' }
  | {
      readonly product: ProductRecord;
      readonly refreshFailure?: FailureReason;
      readonly response: RecordsResponse;
      readonly status: 'ready';
    };

/** One route lifetime, no global cache. React subscribes at its framework edge; stale reads cannot replace a newer result. */
export const createProductDetailQuery = (
  routeId: string,
  read: (onOutcome: (outcome: LoadOutcome) => void) => void = (onOutcome) => loadProductDetail(routeId, onOutcome),
) => {
  const validId = Schema.is(ProductIdSchema)(routeId);
  const initial: ProductDetailSnapshot = validId ? { status: 'loading' } : { status: 'invalid' };
  let snapshot: ProductDetailSnapshot = initial;
  let generation = 0;
  let started = false;
  const listeners = new Set<() => void>();
  const publish = (next: ProductDetailSnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const reload = () => {
    if (!validId || listeners.size === 0) {
      return;
    }
    started = true;
    generation += 1;
    const requestedGeneration = generation;
    read((outcome) => {
      if (requestedGeneration !== generation || listeners.size === 0) {
        return;
      }
      if (!outcome.ok) {
        publish(
          snapshot.status === 'ready' && outcome.reason !== 'forbidden'
            ? { ...snapshot, refreshFailure: outcome.reason }
            : { reason: outcome.reason, status: 'error' },
        );
        return;
      }
      const product = outcome.response.products.find((entry) => entry.id === routeId);
      publish(
        product === undefined ? { status: 'not-found' } : { product, response: outcome.response, status: 'ready' },
      );
    });
  };
  return {
    getServerSnapshot: () => initial,
    getSnapshot: () => snapshot,
    reload,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!started) {
        reload();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation += 1;
          started = false;
        }
      };
    },
  };
};

export const productNavigationFailureKey = Match.type<Cause.TimeoutError | Cause.UnknownError>().pipe(
  Match.tag('TimeoutError', () => 'messages.navigationTimeout'),
  Match.tag('UnknownError', () => 'messages.failed'),
  Match.exhaustive,
);
