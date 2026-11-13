import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { companyVatOf } from '../../provoz/produkty/product-tax-classification.ts';
import type { CompanyVat } from '../../provoz/produkty/product-tax-classification.ts';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { LIST_WARM_ROWS, makeIntentLimiter, makePointerDwell, rowIntentProps, useHeldSnapshot } from '@app/admin-ui';
import type { RowIntentProps } from '@app/admin-ui';
import { Data, Effect, Match, MutableRef, Option, Predicate, Random, Result, Schema } from 'effect';
import {
  changeConcerns,
  definePageData,
  moduleChangeEvent,
  moduleWriteEvent,
  pageDataPending,
  pageDataScopeKey,
} from '@app/shared-contracts/page-data';
import type { ModulePageContext, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type {
  Order,
  ProductRecord,
  RecordsRequestEncoded,
  RecordsResponse,
} from '../../../../../shared/apis/records.ts';
import type { OrderStatus, ProductId, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { OrderIdSchema, PartyIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import { executeManageCatalog } from '../../../../api/manage-catalog-action-client.ts';
import { executeCleanupDemo } from '../../../../api/cleanup-demo-action-client.ts';
import { executeChangeOrderStatus } from '../../../../api/change-order-status-action-client.ts';
import { committedResult } from '../../../../api/action-result.ts';
import { executeRecords } from '../../../../api/records-consumer.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useKeptDetail } from '../../../../runtime/kept-detail.ts';
import type { DetailRead } from '../../../../runtime/kept-detail.ts';
import { useSettledPageData } from '../../../../runtime/page-data-hooks.ts';
import type { SettledPageData } from '../../../../runtime/page-data-hooks.ts';
import { customerDirectoryData } from './customers-directory.ts';

const ORDERS_MODULE = 'demo.merchandise';

/** What the orders table asks the server for: filters and one page, newest first. */
export interface OrdersQuery {
  /** Customers whose register name matches `search`; their orders match it too. */
  readonly customerPartyIds: readonly string[];
  readonly limit: number;
  readonly offset: number;
  readonly search: string;
  readonly status: OrderStatus | null;
  /** Ids of the orders carrying the selected tag; null = no tag filter. */
  readonly taggedIds: readonly string[] | null;
}

/** Header counts the indicators do not carry, each one counted by the server. */
export interface OrderCounts {
  readonly cancelled: number;
  readonly shipped: number;
}

export interface OrdersSnapshot {
  /** Null until the counts land or when they failed. */
  readonly counts: OrderCounts | null;
  readonly query: OrdersQuery;
  readonly records: RecordsResponse;
}

export type OrdersState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'forbidden' }
  | ({ readonly kind: 'ready' } & OrdersSnapshot);

export interface NewOrderLine {
  readonly productId: ProductId;
  readonly quantity: number;
  readonly variantId?: VariantId;
}

const correlation = (purpose: string) =>
  Random.nextInt.pipe(Effect.map((nonce) => `merchandise-orders:${purpose}:${nonce}`));

/** Effect-sourced token for order ids and idempotency keys: four 32-bit draws as hex. */
const randomToken = Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt], {
  concurrency: 1,
}).pipe(Effect.map((parts) => parts.map((part) => (part + 2 ** 31).toString(16).padStart(8, '0')).join('')));

/** One page of orders and no products. */
type OrderViewDraft = {
  -readonly [Key in keyof NonNullable<RecordsRequestEncoded['view']>]: NonNullable<RecordsRequestEncoded['view']>[Key];
};
export const ordersView = (query: OrdersQuery) => {
  const view: OrderViewDraft = { limit: 0, ordersLimit: query.limit, ordersOffset: query.offset };
  if (query.search.trim() !== '') {
    view.orderSearch = query.search.trim();
    if (query.customerPartyIds.length !== 0) {
      view.orderCustomerPartyIds = [...query.customerPartyIds];
    }
  }
  if (query.status !== null) {
    view.orderStatus = query.status;
  }
  if (query.taggedIds !== null) {
    view.taggedOrderIds = [...query.taggedIds];
  }
  return view;
};

const loadOrders = Effect.fn('OrdersRecords.load')(function* loadOrders(query: OrdersQuery) {
  const requestCorrelation = yield* correlation('records');
  return yield* executeRecords({ view: ordersView(query) }, requestCorrelation);
});

/** Number of orders in one status; no rows travel. */
const countOrders = (status: OrderStatus) =>
  correlation('count').pipe(
    Effect.flatMap((id) => executeRecords({ view: { limit: 0, ordersLimit: 0, orderStatus: status } }, id)),
    Effect.map((response) => response.totalOrders ?? 0),
  );

const loadCounts = Effect.all(
  { cancelled: countOrders('CANCELLED'), shipped: countOrders('SHIPPED') },
  {
    concurrency: 2,
  },
);

type LoadFailure = Effect.Error<ReturnType<typeof loadOrders>>;

/** A revision conflict reaches the page as a 409 problem with its own code; other 409s are different conflicts. */
export const isRevisionConflict = (error: CreateFailure): boolean =>
  Match.value(error).pipe(
    Match.tag(
      'ManageCatalogActionConflictProblem',
      (problem): boolean => problem.code === 'merchandise_revision_conflict',
    ),
    Match.orElse((): boolean => false),
  );

export const loadFailureKind = (error: LoadFailure): 'error' | 'forbidden' =>
  Match.value(error).pipe(
    Match.tag('RecordsForbiddenProblem', (): 'forbidden' => 'forbidden'),
    Match.orElse((): 'error' => 'error'),
  );

/** Input of the orders list data: the company and one filtered page. */
export interface OrdersPageInput {
  readonly legalEntityId: string;
  readonly query: OrdersQuery;
  readonly scope?: string | undefined;
}

// Scalar effect dependencies retain array order and distinguish no tag filter from an empty match.
const QueryIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeQueryIds = Schema.encodeResult(QueryIdsJson);
const decodeQueryIds = Schema.decodeResult(QueryIdsJson);

/** Everything `ordersView` sends, in a fixed order: equal requests share one entry. */
const ordersPageKey = ({ legalEntityId, query, scope }: OrdersPageInput): string => {
  const search = query.search.trim();
  return Result.getOrThrow(
    encodeQueryIds([
      legalEntityId,
      scope ?? '',
      String(query.limit),
      String(query.offset),
      query.status ?? '',
      search,
      search === '' ? '' : Result.getOrThrow(encodeQueryIds(query.customerPartyIds)),
      query.taggedIds === null ? '*' : Result.getOrThrow(encodeQueryIds(query.taggedIds)),
    ]),
  );
};

/** One page of orders per company and request. */
export const ordersPageData = definePageData({
  changesFrom: ['merchandise'],
  key: ordersPageKey,
  load: ({ query }: OrdersPageInput) => loadOrders(query),
  maxEntries: 16,
  retainStale: false,
  runtime: browserRuntime,
});

/** The header counts per authenticated scope; they do not depend on the filters. Legacy standalone keys are companies. */
export const orderCountsData = definePageData({
  changesFrom: ['merchandise'],
  key: (legalEntityId: string) => legalEntityId,
  load: () => loadCounts,
  maxEntries: 16,
  retainStale: false,
  runtime: browserRuntime,
});

/** Last ready reads of the orders list and of its counts, kept for a list reopened after a full order page. */
const ordersListMemory = MutableRef.make(new Map<string, ReturnType<typeof ordersPageData.snapshot>>());
const ordersCountsMemory = MutableRef.make(new Map<string, ReturnType<typeof orderCountsData.snapshot>>());

/**
 * Drops what a reopened orders list may show from before a write. An owner-local write may end without the Shell's
 * write event (an uncertain outcome), so the write path calls this as well.
 */
export const forgetRememberedOrders = (): void => {
  MutableRef.get(ordersListMemory).clear();
  MutableRef.get(ordersCountsMemory).clear();
};

/** The page the orders list opens with: no filters, newest first. */
export const firstOrdersPage = (limit: number): OrdersQuery => ({
  customerPartyIds: [],
  limit,
  offset: 0,
  search: '',
  status: null,
  taggedIds: null,
});

/** Staff with order editing see customer names from the directory; dispatch reads no directory. */
export const recordsCanEditOrders = (records: RecordsResponse): boolean => records.canEditOrders ?? records.canWrite;

/**
 * Scopes whose last first read said the person may edit orders. Only the yes is kept, and a no removes it; with it,
 * the next document of that scope asks for the customer names together with its first page. The tab's sessionStorage
 * carries the yes to the next document; memory alone serves when storage is blocked.
 */
const mayEditOrdersMemory = MutableRef.make(new Set<string>());
const mayEditOrdersStorageKey = (scope: string): string => `merchandise.orders.may-edit:${scope}`;

const sessionStorageOrUndefined = (): Storage | undefined =>
  'sessionStorage' in globalThis ? globalThis.sessionStorage : undefined;

const rememberedMayEditOrders = (scope: string | undefined): boolean => {
  if (scope === undefined) {
    return false;
  }
  if (MutableRef.get(mayEditOrdersMemory).has(scope)) {
    return true;
  }
  try {
    return sessionStorageOrUndefined()?.getItem(mayEditOrdersStorageKey(scope)) === 'yes';
  } catch {
    return false;
  }
};

const rememberMayEditOrders = (scope: string | undefined, mayEdit: boolean): void => {
  if (scope === undefined) {
    return;
  }
  if (mayEdit) {
    MutableRef.get(mayEditOrdersMemory).add(scope);
  } else {
    MutableRef.get(mayEditOrdersMemory).delete(scope);
  }
  try {
    if (mayEdit) {
      sessionStorageOrUndefined()?.setItem(mayEditOrdersStorageKey(scope), 'yes');
    } else {
      sessionStorageOrUndefined()?.removeItem(mayEditOrdersStorageKey(scope));
    }
  } catch {
    // Storage is full or blocked: the next document starts as the first one does.
  }
};

/**
 * Prepares the first page, the header counts and, for staff who edit orders, the customer directory the names come
 * from, so the page opens with all of them in place. The directory starts with the first page when the last answer
 * for this scope was yes; otherwise it starts once the first read says so.
 */
export const preloadOrdersPage = (
  legalEntityId: string,
  limit: number,
  context?: ModulePageContext,
): Effect.Effect<void> => {
  const scope = pageDataScopeKey(context, ORDERS_MODULE);
  const input: OrdersPageInput = {
    legalEntityId,
    query: firstOrdersPage(limit),
    scope,
  };
  const remembered = rememberedMayEditOrders(scope);
  const firstPage = ordersPageData.preload(input).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const page = ordersPageData.snapshot(input);
        if (page.state !== 'ready') {
          return Effect.void;
        }
        const mayEdit = recordsCanEditOrders(page.value);
        rememberMayEditOrders(scope, mayEdit);
        // Already asked for with the page: asking again here would repeat a request that failed at once.
        return mayEdit && !remembered ? customerDirectoryData.preload(legalEntityId) : Effect.void;
      }),
    ),
  );
  // A remembered yes starts the directory now. Its request runs next to the first read, not after it.
  const names = remembered ? customerDirectoryData.preload(legalEntityId) : Effect.void;
  return Effect.all([firstPage, names, orderCountsData.preload(input.scope ?? legalEntityId)], {
    concurrency: 3,
    discard: true,
  });
};

/** The page's orders state from the last settled read; a failed count reads as unknown (a dash), never as zero. */
const ordersState = (
  settled: SettledPageData<OrdersPageInput, RecordsResponse, LoadFailure> | undefined,
  counts: PageDataSnapshot<OrderCounts, unknown>,
): OrdersState => {
  if (settled === undefined) {
    return { kind: 'loading' };
  }
  const { snapshot } = settled;
  return snapshot.state === 'failed'
    ? { kind: loadFailureKind(snapshot.error) }
    : {
        counts: counts.state === 'ready' ? counts.value : null,
        kind: 'ready',
        query: settled.input.query,
        records: snapshot.value,
      };
};

export interface OrderDetailRecords {
  /** The order wrote ORDER stock movements (checked on the ledger of its first line's product). */
  readonly movesStock: boolean;
  /**
   * The products on the order's lines: list rows, and full records (with variants) for products a line sells as a
   * variant, since the variant carries that line's stock and quantity rules.
   */
  readonly products: readonly ProductRecord[];
  readonly revision: number;
  /** The company's VAT rates (current and scheduled); the edit form takes a new line's rate from them. */
  readonly vat: CompanyVat;
}

const OrderDetailIncomplete = Data.TaggedError('OrderDetailIncomplete');

/** The products of the order's lines, and whether the order took goods from stock. */
const loadOrderDetail = Effect.fn('OrdersRecords.loadDetail')(function* loadOrderDetail(order: Order) {
  const productIds = [...new Set(order.lines.map((line) => line.productId))].slice(0, 250);
  const variantProductIds = [
    ...new Set(order.lines.flatMap((line) => (line.variantId === undefined ? [] : [line.productId]))),
  ];
  const [rows, full, ledgers] = yield* Effect.all(
    [
      correlation('detail-products').pipe(
        Effect.flatMap((id) =>
          executeRecords({ view: { limit: productIds.length, ordersLimit: 0, productIds, summary: true } }, id),
        ),
      ),
      Effect.forEach(
        variantProductIds,
        (productId) =>
          correlation('detail-variant').pipe(
            Effect.flatMap((id) => executeRecords({ view: { limit: 1, ordersLimit: 0, productIds: [productId] } }, id)),
          ),
        { concurrency: 1 },
      ),
      // Movements come only with a single `productId`: the first line's product ledger tells whether stock moved.
      Effect.forEach(
        productIds.slice(0, 1),
        (productId) =>
          correlation('detail-ledger').pipe(
            Effect.flatMap((id) =>
              executeRecords({ view: { limit: 1, ordersLimit: 0, productId, summary: true } }, id),
            ),
          ),
        { concurrency: 1 },
      ),
    ],
    // Two background rows leave the third request slot to a foreground detail.
    { concurrency: 1 },
  );
  const rowsById = new Map(rows.products.map((product) => [product.id, product]));
  const fullById = new Map(
    full.flatMap((response) => response.products.map((product) => [product.id, product] as const)),
  );
  // A successful transport is not proof that every independently required product/variant was returned.
  // Never retain a summary as a ready replacement for an absent full variant record.
  if (
    productIds.some((productId) => !rowsById.has(productId)) ||
    order.lines.some(
      (line) =>
        line.variantId !== undefined &&
        fullById.get(line.productId)?.variantRecords?.some((variant) => variant.id === line.variantId) !== true,
    )
  ) {
    return yield* new OrderDetailIncomplete<{ readonly section: 'products' }>({ section: 'products' });
  }
  return {
    movesStock: ledgers.some((ledger) =>
      ledger.movements.some((movement) => movement.reason === 'ORDER' && movement.reference === order.number),
    ),
    products: rows.products.map((product) => fullById.get(product.id) ?? product),
    revision: Math.max(
      rows.revision,
      ...full.map((response) => response.revision),
      ...ledgers.map((ledger) => ledger.revision),
    ),
    vat: companyVatOf(rows),
  } satisfies OrderDetailRecords;
});

/** One order by id: the detail reads its own copy, so it is fresh after a change and works from a link. */
const loadOrderById = (orderId: string) =>
  correlation('detail-order').pipe(
    Effect.flatMap((id) => executeRecords({ view: { limit: 0, orderId, ordersLimit: 1 } }, id)),
    Effect.map((response) => ({
      order: response.orders.find((order) => order.id === orderId),
      revision: response.revision,
    })),
  );

class OrderDetailNotFound extends Data.TaggedError('OrderDetailNotFound') {}

interface OrderDetailInput {
  readonly orderId: string;
  readonly revision?: number | undefined;
  readonly scope: string;
  readonly source?: OrdersPageInput | undefined;
}

/** Readers per list key that are mounted now: a list a reader shows is one the detail may read and join. */
const mountedLists = MutableRef.make<ReadonlyMap<string, number>>(new Map());

/**
 * The rows of the list an order was opened from. A list a mounted reader shows is read as before (fresh, or joined
 * while it loads). A list nobody shows answers only from a ready snapshot; otherwise it stays unread and the order
 * loads by id, so a background refresh never reads the whole list again.
 */
const listedRows = (source: OrdersPageInput): Effect.Effect<Option.Option<RecordsResponse>, LoadFailure> => {
  if (MutableRef.get(mountedLists).has(ordersPageData.key(source))) {
    return ordersPageData.read(source).pipe(Effect.map(Option.some));
  }
  const snapshot = ordersPageData.snapshot(source);
  return Effect.succeed(snapshot.state === 'ready' ? Option.some(snapshot.value) : Option.none());
};

const loadDetailInput = Effect.fn('OrdersRecords.loadDetailInput')(function* loadDetailInput(input: OrderDetailInput) {
  const source = input.source === undefined ? undefined : Option.getOrUndefined(yield* listedRows(input.source));
  const listed = source?.orders.find((order) => order.id === input.orderId);
  const record =
    listed === undefined ? yield* loadOrderById(input.orderId) : { order: listed, revision: source?.revision ?? 0 };
  if (record.order === undefined) {
    return yield* new OrderDetailNotFound();
  }
  const detail = yield* loadOrderDetail(record.order);
  return { ...detail, order: record.order, revision: Math.max(record.revision, detail.revision) };
});

const ORDER_DETAIL_CHANGES_FROM = ['merchandise'];

/** Only successful governed data is reusable. Missing rows and denials are retried on the next opening. */
const orderDetailStore = definePageData({
  cancelWhenUnused: true,
  changesFrom: ORDER_DETAIL_CHANGES_FROM,
  key: (input: OrderDetailInput) =>
    Result.getOrThrow(encodeQueryIds([input.scope, input.orderId, String(input.revision)])),
  load: loadDetailInput,
  maxEntries: 256,
  retainStale: false,
  runtime: browserRuntime,
});

type OrderDetailValue = Effect.Success<ReturnType<typeof loadDetailInput>>;
type OrderDetailSnapshot = ReturnType<typeof orderDetailStore.snapshot>;

/**
 * The last warm-up of each order in a scope: the detail input it used (so an opening without the list, the full
 * order page, finds the same revision-qualified entry) and its result as a stable ready snapshot. The strict store
 * reads as pending once that result is 20 s old; an opening of the same entry then shows this copy at once and the
 * store reads the order again in the background, as for a panel that stays open. A write or a change of the orders
 * drops every copy, so an invalidated order always loads again.
 */
interface WarmOrderDetail {
  readonly input: OrderDetailInput;
  readonly key: string;
  readonly snapshot: OrderDetailSnapshot;
}
const WARM_ORDER_DETAILS = 256;
const warmOrderDetails = MutableRef.make<ReadonlyMap<string, WarmOrderDetail>>(new Map());
/**
 * The detail input of each warm-up still under way. The full order page has no list row to take the revision from;
 * with this one it opens the very entry being read and joins that read instead of loading the order again by id.
 */
interface WarmingOrderDetail {
  readonly input: OrderDetailInput;
  readonly key: string;
  /** Warm-ups of this entry running now: the list's and an opening's join the same read. */
  readonly runs: number;
}
const warmingOrderDetails = MutableRef.make<ReadonlyMap<string, WarmingOrderDetail>>(new Map());
const forgetAllWarmOrderDetails = (): void => {
  MutableRef.set(warmOrderDetails, new Map());
  MutableRef.set(warmingOrderDetails, new Map());
};
const warmDetailId = (scope: string, orderId: string): string => Result.getOrThrow(encodeQueryIds([scope, orderId]));

const forgetWarmOrderDetails = (event: Event): void => {
  if (changeConcerns(event, ORDER_DETAIL_CHANGES_FROM)) {
    forgetAllWarmOrderDetails();
  }
};
if ('addEventListener' in globalThis) {
  globalThis.addEventListener(moduleWriteEvent, forgetWarmOrderDetails);
  globalThis.addEventListener(moduleChangeEvent, forgetWarmOrderDetails);
}

/** The order detail store; invalidating it (every own write, every reload of the list) also drops the warm copies. */
export const orderDetailData: typeof orderDetailStore = {
  ...orderDetailStore,
  invalidate: () => {
    forgetAllWarmOrderDetails();
    orderDetailStore.invalidate();
  },
};

/** Remembers one warm-up. Bounded like the store itself; the oldest warm-ups go first. */
const rememberWarmOrderDetail = (input: OrderDetailInput, value: OrderDetailValue): void => {
  const id = warmDetailId(input.scope, input.orderId);
  const warm: WarmOrderDetail = {
    input,
    key: orderDetailData.key(input),
    snapshot: { refreshing: true, state: 'ready', value },
  };
  const others = [...MutableRef.get(warmOrderDetails)].filter(([known]) => known !== id);
  MutableRef.set(warmOrderDetails, new Map([...others, [id, warm] as const].slice(-WARM_ORDER_DETAILS)));
};

/**
 * Counts a warm-up of `input` in (`started`) or out. A newer entry of the order replaces the count of an older one;
 * the order is no longer warming once its last warm-up of the entry ends. Bounded like the warm copies.
 */
const markWarming = (input: OrderDetailInput, started: boolean): void => {
  const id = warmDetailId(input.scope, input.orderId);
  const key = orderDetailData.key(input);
  const current = MutableRef.get(warmingOrderDetails);
  const known = current.get(id);
  const runs = (known?.key === key ? known.runs : 0) + (started ? 1 : -1);
  if (!started && known?.key !== key) {
    return;
  }
  const others = [...current].filter(([other]) => other !== id);
  MutableRef.set(
    warmingOrderDetails,
    new Map(runs > 0 ? [...others, [id, { input, key, runs }] as const].slice(-WARM_ORDER_DETAILS) : others),
  );
};

/** Reads one order's detail for a warm-up and remembers it for an opening that comes later. */
const warmOrderDetail = (input: OrderDetailInput): Effect.Effect<void> =>
  Effect.sync(() => markWarming(input, true)).pipe(
    Effect.andThen(orderDetailData.read(input)),
    Effect.tap((value) => Effect.sync(() => rememberWarmOrderDetail(input, value))),
    Effect.ignore,
    Effect.ensuring(Effect.sync(() => markWarming(input, false))),
  );

/**
 * Caller supplies exactly the authorized current page, not a catalogue or all paginated results. Only its first
 * `LIST_WARM_ROWS` orders are warmed; every other row is warmed by its intent.
 */
export const preloadOrderDetails = (input: OrdersPageInput, records: RecordsResponse): Effect.Effect<void> =>
  input.scope === undefined
    ? Effect.void
    : Effect.forEach(
        records.orders.slice(0, Math.min(input.query.limit, LIST_WARM_ROWS)),
        (order) =>
          warmOrderDetail({ orderId: order.id, revision: records.revision, scope: input.scope ?? '', source: input }),
        { concurrency: 2, discard: true },
      );

const orderIntentReads = makeIntentLimiter();
const orderPointerDwell = makePointerDwell((effect) => browserRuntime.runFork(effect));

/**
 * Warms one order's detail when the user shows the intent to open its row. The strict detail store does the rest: a
 * fresh entry answers at once without a request and a running read is joined, so each row has at most one read.
 * At most two intent reads run at once; a sweep over many rows keeps only the newest waiting.
 */
export const prefetchOrderDetail = (input: OrdersPageInput, records: RecordsResponse, orderId: string): void => {
  if (input.scope === undefined) {
    return;
  }
  const detail: OrderDetailInput = { orderId, revision: records.revision, scope: input.scope, source: input };
  if (orderDetailData.snapshot(detail).state === 'ready') {
    return;
  }
  orderIntentReads((done) => {
    if (orderDetailData.snapshot(detail).state === 'ready') {
      done();
      return;
    }
    browserRuntime.runFork(warmOrderDetail(detail).pipe(Effect.ensuring(Effect.sync(done))));
  });
};

/**
 * Keeps the read of an order the list is leaving for running. Opening a row on the full order page replaces the list,
 * which stops its warm-up and with it a read of that row still under way; this read takes it over (or starts it from
 * the list's rows), so the order page joins it instead of reading the order again. Call it before navigating.
 */
export const openOrderDetail = (input: OrdersPageInput, records: RecordsResponse, orderId: string): void => {
  if (input.scope === undefined) {
    return;
  }
  const detail: OrderDetailInput = { orderId, revision: records.revision, scope: input.scope, source: input };
  if (orderDetailData.snapshot(detail).state !== 'ready') {
    browserRuntime.runFork(warmOrderDetail(detail));
  }
};

/** Intent prefetch of the orders table: `orders` are its rows in table order (no client sorting). */
export const orderDetailIntent = (
  input: OrdersPageInput,
  records: RecordsResponse | undefined,
  orders: readonly Order[],
): RowIntentProps =>
  rowIntentProps((index) => {
    const order = orders[index];
    if (records !== undefined && order !== undefined) {
      prefetchOrderDetail(input, records, order.id);
    }
  }, orderPointerDwell);

/** One governed command. Every call carries a fresh idempotency key and the revision the caller last saw. */
const submitCommand = Effect.fn('OrdersRecords.submitCommand')(function* submitCommand(
  command: Extract<
    MerchandiseCommand,
    { readonly _tag: 'CreateOrder' | 'EditOrder' | 'ResetDemoData' | 'RemoveDemoOrder' | 'ChangeOrderStatus' }
  >,
  expectedRevision: number,
) {
  const requestCorrelation = yield* correlation('command');
  const idempotencyKey = yield* randomToken;
  const options = { idempotencyKey };
  const operation = Match.value(command).pipe(
    Match.tag('CreateOrder', 'EditOrder', (value) =>
      executeManageCatalog({ command: value, expectedRevision }, requestCorrelation, options),
    ),
    Match.tag('ResetDemoData', 'RemoveDemoOrder', (value) =>
      executeCleanupDemo({ command: value, expectedRevision }, requestCorrelation, options),
    ),
    Match.tag('ChangeOrderStatus', (value) =>
      executeChangeOrderStatus({ command: value, expectedRevision }, requestCorrelation, options),
    ),
    Match.exhaustive,
  );
  return yield* operation.pipe(
    Effect.flatMap(committedResult),
    Effect.ensuring(
      Effect.sync(() => {
        forgetRememberedOrders();
        ordersPageData.invalidate();
        orderDetailData.invalidate();
      }),
    ),
  );
});

export const createOrder = Effect.fn('OrdersRecords.createOrder')(function* createOrder(input: {
  readonly lines: readonly NewOrderLine[];
  readonly partyId: string;
  readonly revision: number;
}) {
  const id = yield* randomToken.pipe(Effect.flatMap((token) => Schema.decodeEffect(OrderIdSchema)(token)));
  const partyId = yield* Schema.decodeEffect(PartyIdSchema)(input.partyId);
  return yield* submitCommand({ _tag: 'CreateOrder', id, lines: [...input.lines], partyId }, input.revision);
});

export type CreateFailure = Effect.Error<ReturnType<typeof createOrder>>;

/** Admin edit of one order (lines, prices, shipping, address, contact, note); the server writes the history. */
export const editOrder = Effect.fn('OrdersRecords.editOrder')(function* editOrder(
  command: Extract<MerchandiseCommand, { readonly _tag: 'EditOrder' }>,
  revision: number,
) {
  return yield* submitCommand(command, revision);
});

/** AKROS administrators: resets this company's catalog, stock and orders to the demo baseline. */
export const resetDemoData = Effect.fn('OrdersRecords.resetDemoData')(function* resetDemoData(
  reason: string,
  revision: number,
) {
  return yield* submitCommand({ _tag: 'ResetDemoData', confirmation: 'OBNOVIT', reason }, revision);
});

/**
 * Sequential on purpose: each change advances the revision the next one must expect.
 * A failed change is counted and the run continues; the error channel stays empty.
 */
interface StatusProgress {
  readonly changed: number;
  readonly failed: number;
  readonly proposals?: readonly ActionProposalAccepted[];
  readonly revision: number;
}

const applyStatusStep = (
  progress: StatusProgress,
  order: Order,
  status: OrderStatus,
  reason: string | undefined,
): Effect.Effect<StatusProgress> => {
  const change = { _tag: 'ChangeOrderStatus', id: order.id, status } satisfies MerchandiseCommand;
  const command = reason === undefined ? change : { ...change, reason };
  return submitCommand(command, progress.revision).pipe(
    Effect.match({
      onFailure: (failure): StatusProgress =>
        Schema.is(ActionProposalAcceptedSchema)(failure)
          ? { ...progress, proposals: [...(progress.proposals ?? []), failure] }
          : { ...progress, failed: progress.failed + 1 },
      onSuccess: (result): StatusProgress => ({
        ...progress,
        changed: progress.changed + 1,
        revision: result.revision,
      }),
    }),
  );
};

export const changeOrderStatuses = (input: {
  readonly orders: readonly Order[];
  /** Optional audit reason; for a cancellation it also appears in the customer's e-mail. */
  readonly reason?: string;
  readonly revision: number;
  readonly status: OrderStatus;
}): Effect.Effect<StatusProgress> =>
  Effect.reduce(
    input.orders,
    (): StatusProgress => ({ changed: 0, failed: 0, revision: input.revision }),
    (progress, order) => applyStatusStep(progress, order, input.status, input.reason),
  );

// A reader that shows no counts listens to none.
const noopSubscribe = (): (() => void) => () => {
  // Nothing to unsubscribe: the counts store is not read.
};

/**
 * `counts: false` leaves the header counts unread and unmounted; `warm: false` skips the warm-up of the first rows.
 * Both default on, the orders list's behaviour. A reader that shows neither (the full order page takes only the
 * permissions) passes both off.
 */
export interface UseOrdersOptions {
  readonly counts?: boolean;
  readonly warm?: boolean;
}

/**
 * One page of orders for `query` with the header counts. `state.query` tells which query the state answers: while
 * another query loads it is still the previous one, and the table shows its loading rows. A reload of the query on
 * screen keeps its rows, capabilities and counts until the reload settles. `load` reads the page and the counts
 * again after a change.
 */
export const useOrders = (
  legalEntityId: string,
  query: OrdersQuery,
  context?: ModulePageContext,
  options: UseOrdersOptions = {},
) => {
  const countsOn = options.counts !== false;
  const warmOn = options.warm !== false;
  const scope = pageDataScopeKey(context, ORDERS_MODULE);
  const countsKey = scope ?? legalEntityId;
  const input: OrdersPageInput = { legalEntityId, query, scope };
  const listKey = ordersPageData.key(input);
  const page = useSyncExternalStore(
    (listener) => ordersPageData.subscribe(listener, input),
    () => ordersPageData.snapshot(input),
    () => pageDataPending,
  );
  const counts = useSyncExternalStore(
    countsOn ? (listener) => orderCountsData.subscribe(listener, countsKey) : noopSubscribe,
    () => (countsOn ? orderCountsData.snapshot(countsKey) : pageDataPending),
    () => pageDataPending,
  );
  const { limit, offset, search, status } = query;
  const customerPartyIdsJson = Result.getOrThrow(encodeQueryIds(query.customerPartyIds));
  const taggedIdsJson = query.taggedIds === null ? null : Result.getOrThrow(encodeQueryIds(query.taggedIds));
  // Rebuild the request in the effect; equal query values need no object-identity memo or new ensure.
  useEffect(() => {
    ordersPageData.ensure({
      legalEntityId,
      query: {
        customerPartyIds: Result.getOrThrow(decodeQueryIds(customerPartyIdsJson)),
        limit,
        offset,
        search,
        status,
        taggedIds: taggedIdsJson === null ? null : Result.getOrThrow(decodeQueryIds(taggedIdsJson)),
      },
      scope,
    });
  }, [customerPartyIdsJson, legalEntityId, limit, offset, scope, search, status, taggedIdsJson]);
  // A reader that shows the list keeps its key registered, so a detail read of the same list joins it instead of
  // skipping it (`listedRows`).
  useEffect(() => {
    const setReaders = (update: (readers: number) => number) => {
      const next = new Map(MutableRef.get(mountedLists));
      const readers = update(next.get(listKey) ?? 0);
      if (readers > 0) {
        next.set(listKey, readers);
      } else {
        next.delete(listKey);
      }
      MutableRef.set(mountedLists, next);
    };
    setReaders((readers) => readers + 1);
    return () => {
      setReaders((readers) => readers - 1);
    };
  }, [listKey]);
  useEffect(() => {
    if (countsOn) {
      orderCountsData.ensure(countsKey);
    }
  }, [countsKey, countsOn]);
  // The strict stores read as pending while they reload (freshness window, live change, settled write). The table
  // keeps the last ready read of the same request and the header its counts until the reload settles; another
  // request never reuses them, and a failed or refused reload replaces them at once.
  // The list and its counts start from their last ready read when reopened after a full order page (`memory`).
  const shownPage = useHeldSnapshot(ordersPageData.key(input), page, { memory: MutableRef.get(ordersListMemory) });
  const shownCounts = useHeldSnapshot(countsKey, counts, { memory: MutableRef.get(ordersCountsMemory) });
  const settled = useSettledPageData(shownPage, input);
  // One warm-up per request, list revision and rows. The strict detail entries read as pending again once their 20 s
  // freshness window passes or a live change arrives, and each reload of the page settles as a new snapshot; warming
  // every row on each of them made an idle list re-read all its details. A write or a change of these orders moves
  // the revision and warms the rows again; a row opened later is warmed by intent (`orderDetailIntent`).
  const batch =
    page.state === 'ready'
      ? Result.getOrThrow(
          encodeQueryIds([
            ordersPageData.key(input),
            String(page.value.revision),
            ...page.value.orders.map((order) => order.id),
          ]),
        )
      : undefined;
  const warmed = useRef<string>(undefined);
  const prefetch = useEffectEvent((records: RecordsResponse, key: string) =>
    preloadOrderDetails(input, records).pipe(
      Effect.andThen(
        Effect.sync(() => {
          warmed.current = key;
        }),
      ),
    ),
  );
  // Prefetch only the current request, never the previous page retained while a filter loads.
  useEffect(() => {
    const fiber =
      warmOn &&
      scope !== undefined &&
      page.state === 'ready' &&
      !page.refreshing &&
      batch !== undefined &&
      warmed.current !== batch
        ? browserRuntime.runFork(prefetch(page.value, batch))
        : undefined;
    return () => {
      fiber?.interruptUnsafe();
    };
  }, [batch, page, scope, warmOn]);
  return {
    load: () => {
      orderDetailData.invalidate();
      browserRuntime.runFork(
        Effect.all([ordersPageData.refresh(input), ...(countsOn ? [orderCountsData.refresh(countsKey)] : [])], {
          concurrency: 2,
          discard: true,
        }),
      );
    },
    state: ordersState(
      settled !== undefined &&
        settled.input.scope === scope &&
        settled.input.legalEntityId === legalEntityId &&
        // Either the read of the request on screen (held while it reloads), or the page of the previous request,
        // which may stand in only while the store still has it.
        (settled.snapshot === shownPage || ordersPageData.snapshot(settled.input) === settled.snapshot)
        ? settled
        : undefined,
      countsOn ? shownCounts : pageDataPending,
    ),
  };
};

/**
 * The current authorized list row behind the opened order. It is a read-only summary while the enriched detail
 * (products, variants, stock and revision) is still loading; it never stands in for canonical detail.
 */
export interface OrderDetailSummary {
  readonly order: Order;
  readonly revision: number;
}

export type OrderDetailState =
  | { readonly status: 'idle' }
  | { readonly status: 'not-found' }
  | { readonly status: 'loading'; readonly summary?: OrderDetailSummary | undefined }
  | { readonly cause: Effect.Error<ReturnType<typeof loadOrderDetail>>; readonly status: 'error' }
  | ({
      readonly order: Order;
      /** The order shown is the last one read: reading it again failed with this cause. */
      readonly reloadFailure?: Effect.Error<ReturnType<typeof loadOrderDetail>>;
      readonly status: 'ready';
    } & OrderDetailRecords);

type OrderDetailFailure = Effect.Error<ReturnType<typeof loadOrderDetail>>;
type ReadyOrderDetail = Extract<OrderDetailState, { readonly status: 'ready' }>;

/** Failures of a denied read (signed out, no access): they never keep the shown order, its fields or actions. */
const deniedFailureTags = [
  'RecordsAuthenticationProblem',
  'RecordsForbiddenProblem',
  'GatewayAuthenticationRequiredProblem',
  'GatewayForbiddenProblem',
] as const;

const orderRead = (state: OrderDetailState): DetailRead<ReadyOrderDetail, OrderDetailFailure> =>
  Match.value(state).pipe(
    Match.when({ status: 'ready' }, (ready): DetailRead<ReadyOrderDetail, OrderDetailFailure> => ({
      kind: 'ready',
      ready,
    })),
    Match.when({ status: 'loading' }, (): DetailRead<ReadyOrderDetail, OrderDetailFailure> => ({ kind: 'loading' })),
    Match.when({ status: 'error' }, ({ cause: failure }): DetailRead<ReadyOrderDetail, OrderDetailFailure> =>
      deniedFailureTags.some((tag) => Predicate.isTagged(failure, tag))
        ? { kind: 'final' }
        : { failure, kind: 'failed' },
    ),
    Match.orElse((): DetailRead<ReadyOrderDetail, OrderDetailFailure> => ({ kind: 'final' })),
  );

/** Only the row of this order from the ready page of the same authenticated scope may summarize it. */
const listedSummary = (
  orderId: string | null,
  scope: string | undefined,
  list: PageDataSnapshot<RecordsResponse, LoadFailure>,
): OrderDetailSummary | undefined => {
  if (orderId === null || scope === undefined || list.state !== 'ready') {
    return undefined;
  }
  const order = list.value.orders.find((candidate) => candidate.id === orderId);
  return order === undefined ? undefined : { order, revision: list.value.revision };
};

/**
 * The list revision that qualifies the open order's entry. The list reads as pending while it reloads (every 20 s
 * while shown) and the full order page has no list row at all: the order then keeps the revision it was opened
 * with, or takes the one its warm-up used, so the opening finds the warmed entry instead of reading the order again.
 */
const useDetailRevision = (
  detailId: string,
  listRevision: number | undefined,
  warmRevision: number | undefined,
): number | undefined => {
  const [opened, setOpened] = useState<{ readonly id: string; readonly revision: number }>();
  const kept = opened?.id === detailId ? opened.revision : warmRevision;
  const revision = listRevision ?? kept;
  if (revision !== undefined && (opened?.id !== detailId || opened.revision !== revision)) {
    setOpened({ id: detailId, revision });
  }
  return revision;
};

/** The last warm-up of an order: its copy, and the revision of the warm-up still under way or of that copy. */
const warmUpOf = (detailId: string | undefined) => {
  const warm = detailId === undefined ? undefined : MutableRef.get(warmOrderDetails).get(detailId);
  const warming = detailId === undefined ? undefined : MutableRef.get(warmingOrderDetails).get(detailId);
  // A warm-up under way reads the list's current revision; a finished copy may be of an older one.
  return { warm, warmRevision: warming?.input.revision ?? warm?.input.revision };
};

/**
 * Nothing of this order shown yet and its warmed entry has aged: the warm copy of the same entry stands in while the
 * detail reads it again. A failed or refused read replaces it at once, as it replaces a held read.
 */
const withWarmCopy = (
  held: OrderDetailSnapshot,
  warm: WarmOrderDetail | undefined,
  key: string,
): OrderDetailSnapshot => (held.state === 'pending' && warm?.key === key ? warm.snapshot : held);

/**
 * The open order with the product records its detail and edit form need. `version` changes after every change the
 * page makes, so the detail reads again.
 */
export const useOrderDetail = (
  orderId: string | null,
  version: number,
  context?: ModulePageContext,
  source?: OrdersPageInput,
): OrderDetailState => {
  const scope = pageDataScopeKey(context, ORDERS_MODULE);
  // A list row may summarize the open order only while it belongs to the same authenticated scope.
  const currentSource = source?.scope === scope ? source : undefined;
  const list = currentSource === undefined ? pageDataPending : ordersPageData.snapshot(currentSource);
  const summary = listedSummary(orderId, scope, list);
  const detailId = warmDetailId(scope ?? '', orderId ?? '');
  const { warm, warmRevision } = warmUpOf(orderId === null || scope === undefined ? undefined : detailId);
  const revision = useDetailRevision(detailId, list.state === 'ready' ? list.value.revision : undefined, warmRevision);
  const input: OrderDetailInput = {
    orderId: orderId ?? '',
    revision,
    scope: scope ?? '',
    source: currentSource,
  };
  const subscribe = (listener: () => void) =>
    orderDetailData.subscribe(
      listener,
      orderId === null || scope === undefined ? undefined : { orderId, revision, scope },
    );
  const stored = useSyncExternalStore(
    subscribe,
    () => (scope === undefined || orderId === null ? pageDataPending : orderDetailData.snapshot(input)),
    () => pageDataPending,
  );
  // The strict store reads as pending while it reloads this order, and the entry moves with the list revision. The
  // detail and its edit form stay mounted on the last ready read of the same order in the same scope until the
  // reload settles; the form's draft decides what a reloaded order means for it (`useOrderEditDraft`).
  const cached = withWarmCopy(useHeldSnapshot(detailId, stored), warm, orderDetailData.key(input));
  // Each answer names the request it answers, so a newer request reads as loading without a synchronous reset.
  const [answer, setAnswer] = useState<{ readonly request: string; readonly state: OrderDetailState } | null>(null);
  const request = Result.getOrThrow(
    encodeQueryIds([scope ?? '', orderId ?? '', String(version), String(input.revision)]),
  );
  const readSelected = useEffectEvent(() =>
    scope === undefined ? loadDetailInput({ orderId: input.orderId, scope: '' }) : orderDetailData.read(input),
  );
  useEffect(() => {
    const fiber =
      orderId === null
        ? undefined
        : browserRuntime.runFork(
            readSelected().pipe(
              Effect.match({
                onFailure: (cause): OrderDetailState =>
                  Predicate.isTagged(cause, 'OrderDetailNotFound')
                    ? { status: 'not-found' }
                    : { cause, status: 'error' },
                onSuccess: (state): OrderDetailState => ({ ...state, status: 'ready' }),
              }),
              Effect.map((state) => setAnswer({ request, state })),
            ),
          );
    return () => {
      fiber?.interruptUnsafe();
    };
  }, [orderId, request]);
  const current = (): OrderDetailState => {
    if (orderId === null) {
      return { status: 'idle' };
    }
    if (scope !== undefined) {
      if (cached.state === 'ready') {
        return { ...cached.value, status: 'ready' };
      }
      if (cached.state === 'failed') {
        return Predicate.isTagged(cached.error, 'OrderDetailNotFound')
          ? { status: 'not-found' }
          : { cause: cached.error, status: 'error' };
      }
      return summary === undefined ? { status: 'loading' } : { status: 'loading', summary };
    }
    if (answer?.request === request) {
      return answer.state;
    }
    // A reread after a change keeps showing the same order until the fresh copy lands.
    return summary === undefined ? { status: 'loading' } : { status: 'loading', summary };
  };
  const state = current();
  // A failed reload of the order on screen keeps it, so an open edit form and its unsaved draft stay.
  const kept = useKeptDetail({
    key: Result.getOrThrow(encodeQueryIds([scope ?? '', orderId ?? ''])),
    read: orderRead(state),
    same: (left, right) =>
      left.order === right.order &&
      left.products === right.products &&
      left.revision === right.revision &&
      left.movesStock === right.movesStock &&
      left.vat === right.vat,
  });
  if (kept === null) {
    return state;
  }
  return kept.reloadFailure === undefined ? kept.ready : { ...kept.ready, reloadFailure: kept.reloadFailure };
};

export const removeDemoOrder = (id: Order['id'], reason: string, revision: number) =>
  submitCommand({ _tag: 'RemoveDemoOrder', id, reason }, revision);
