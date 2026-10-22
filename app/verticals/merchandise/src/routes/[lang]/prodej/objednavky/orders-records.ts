import { Effect, Exit, Match, Random, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Order, ProductRecord, RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { OrderStatus, ProductId, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { OrderIdSchema, PartyIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { readProductRecord } from '../../provoz/produkty/product-reads.ts';

/** What the orders table asks the server for: filters and one page, newest first. */
export interface OrdersQuery {
  readonly limit: number;
  readonly offset: number;
  readonly search: string;
  readonly status: OrderStatus | null;
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
export const ordersView = (query: OrdersQuery) => ({
  limit: 0,
  ordersLimit: query.limit,
  ordersOffset: query.offset,
  ...(query.search.trim() === '' ? {} : { orderSearch: query.search.trim() }),
  ...(query.status === null ? {} : { orderStatus: query.status }),
});

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

/** One governed command. Every call carries a fresh idempotency key and the revision the caller last saw. */
const submitCommand = Effect.fn('OrdersRecords.submitCommand')(function* submitCommand(
  command: MerchandiseCommand,
  expectedRevision: number,
) {
  const requestCorrelation = yield* correlation('command');
  const idempotencyKey = yield* randomToken;
  return yield* executeApplyCommand({ command, expectedRevision }, requestCorrelation, { idempotencyKey });
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

/** A revision conflict reaches the page as a 409 problem with its own code; other 409s are different conflicts. */
export const isRevisionConflict = (error: CreateFailure): boolean =>
  Match.value(error).pipe(
    Match.tag(
      'ApplyCommandActionConflictProblem',
      (problem): boolean => problem.code === 'merchandise_revision_conflict',
    ),
    Match.orElse((): boolean => false),
  );

/**
 * Sequential on purpose: each change advances the revision the next one must expect.
 * A failed change is counted and the run continues; the error channel stays empty.
 */
interface StatusProgress {
  readonly changed: number;
  readonly failed: number;
  readonly revision: number;
}

const applyStatusStep = (
  progress: StatusProgress,
  order: Order,
  status: OrderStatus,
  reason: string | undefined,
): Effect.Effect<StatusProgress> =>
  Effect.exit(
    submitCommand(
      { _tag: 'ChangeOrderStatus', id: order.id, status, ...(reason === undefined ? {} : { reason }) },
      progress.revision,
    ),
  ).pipe(
    Effect.map((outcome): StatusProgress =>
      Exit.isSuccess(outcome)
        ? { ...progress, changed: progress.changed + 1, revision: outcome.value.revision }
        : { ...progress, failed: progress.failed + 1 },
    ),
  );

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

export const loadFailureKind = (error: LoadFailure): 'error' | 'forbidden' =>
  Match.value(error).pipe(
    Match.tag('RecordsForbiddenProblem', (): 'forbidden' => 'forbidden'),
    Match.orElse((): 'error' => 'error'),
  );

/** Reads one page; only the newest read may land, so a slow earlier page never replaces the current one. */
const readPage = (query: OrdersQuery, generation: { current: number }, setState: (next: OrdersState) => void): void => {
  generation.current += 1;
  const requested = generation.current;
  const land = (next: OrdersState) => {
    if (requested === generation.current) {
      setState(next);
    }
  };
  void browserRuntime.runPromise(
    loadOrders(query).pipe(
      Effect.match({
        onFailure: (error): OrdersState => ({ kind: loadFailureKind(error) }),
        onSuccess: (records): OrdersState => ({ counts: null, kind: 'ready', query, records }),
      }),
      Effect.map(land),
    ),
  );
};

/** The header counts; a failed count reads as unknown (a dash), never as zero. */
const readCounts = (setCounts: (next: OrderCounts | null) => void): void => {
  void browserRuntime.runPromise(
    loadCounts.pipe(
      Effect.match({
        onFailure: (): OrderCounts | null => null,
        onSuccess: (counts): OrderCounts | null => counts,
      }),
      Effect.map(setCounts),
    ),
  );
};

/**
 * Loads one page of orders for `query`; a new query reads again. `load` refreshes the page and the header counts
 * after a change. A refresh keeps the current rows until the new read lands.
 */
export const useOrders = (query: OrdersQuery) => {
  const [state, setState] = useState<OrdersState>({ kind: 'loading' });
  const [counts, setCounts] = useState<OrderCounts | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    readPage(query, generation, setState);
  }, [query]);
  useEffect(() => {
    readCounts(setCounts);
  }, []);
  return {
    load: () => {
      readPage(query, generation, setState);
      readCounts(setCounts);
    },
    state: state.kind === 'ready' ? { ...state, counts } : state,
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
}

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
      Effect.forEach(variantProductIds, readProductRecord, { concurrency: 2 }),
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
    { concurrency: 3 },
  );
  const fullById = new Map(full.flatMap((product) => (product === undefined ? [] : [[product.id, product] as const])));
  return {
    movesStock: ledgers.some((ledger) =>
      ledger.movements.some((movement) => movement.reason === 'ORDER' && movement.reference === order.number),
    ),
    products: rows.products.map((product) => fullById.get(product.id) ?? product),
    revision: Math.max(rows.revision, ...ledgers.map((ledger) => ledger.revision)),
  } satisfies OrderDetailRecords;
});

/** One order by id: the detail reads its own copy, so it is fresh after a change and works from a link. */
const loadOrderById = (orderId: string) =>
  correlation('detail-order').pipe(
    Effect.flatMap((id) => executeRecords({ view: { limit: 0, orderId, ordersLimit: 1 } }, id)),
    Effect.map((response) => response.orders.find((order) => order.id === orderId)),
  );

export type OrderDetailState =
  | { readonly status: 'idle' | 'loading' | 'error' | 'not-found' }
  | ({ readonly order: Order; readonly status: 'ready' } & OrderDetailRecords);

/**
 * The open order with the product records its detail and edit form need. `version` changes after every change the
 * page makes, so the detail reads again.
 */
export const useOrderDetail = (orderId: string | null, version: number): OrderDetailState => {
  // Each answer names the request it answers, so a newer request reads as loading without a synchronous reset.
  const [answer, setAnswer] = useState<{ readonly request: string; readonly state: OrderDetailState } | null>(null);
  const request = `${orderId ?? ''}:${version}`;
  useEffect(() => {
    const fiber =
      orderId === null
        ? undefined
        : browserRuntime.runFork(
            loadOrderById(orderId).pipe(
              Effect.flatMap((order) =>
                order === undefined
                  ? Effect.succeed<OrderDetailState>({ status: 'not-found' })
                  : loadOrderDetail(order).pipe(
                      Effect.map((records): OrderDetailState => ({ ...records, order, status: 'ready' })),
                    ),
              ),
              Effect.match({
                onFailure: (): OrderDetailState => ({ status: 'error' }),
                onSuccess: (state): OrderDetailState => state,
              }),
              Effect.map((state) => setAnswer({ request, state })),
            ),
          );
    return () => {
      fiber?.interruptUnsafe();
    };
  }, [orderId, request]);
  if (orderId === null) {
    return { status: 'idle' };
  }
  if (answer?.request === request) {
    return answer.state;
  }
  // A reread after a change keeps showing the same order until the fresh copy lands.
  return answer?.state.status === 'ready' && answer.state.order.id === orderId ? answer.state : { status: 'loading' };
};

export const removeDemoOrder = (id: Order['id'], reason: string, revision: number) =>
  submitCommand({ _tag: 'RemoveDemoOrder', id, reason }, revision);
