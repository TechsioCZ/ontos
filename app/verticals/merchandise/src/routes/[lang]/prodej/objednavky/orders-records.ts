import { DateTime, Effect, Exit, Match, Random, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Order, RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { OrderStatus, ProductId, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { OrderIdSchema, PartyIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

export interface OrdersSnapshot {
  readonly now: DateTime.Utc;
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

const loadOrders = Effect.fn('OrdersRecords.load')(function* loadOrders() {
  const requestCorrelation = yield* correlation('records');
  const records = yield* executeRecords({}, requestCorrelation);
  const now = yield* DateTime.now;
  return { now, records } satisfies OrdersSnapshot;
});

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

const loadInto = (setState: (next: OrdersState) => void): void => {
  void browserRuntime.runPromise(
    loadOrders().pipe(
      Effect.match({
        onFailure: (error) => setState({ kind: loadFailureKind(error) }),
        onSuccess: (snapshot) => setState({ kind: 'ready', ...snapshot }),
      }),
    ),
  );
};

/** Loads the orders page on mount. A refresh keeps the current rows until the new read lands. */
export const useOrders = () => {
  const [state, setState] = useState<OrdersState>({ kind: 'loading' });
  useEffect(() => {
    loadInto(setState);
  }, []);
  return {
    load: () => loadInto(setState),
    state,
  };
};

export const removeDemoOrder = (id: Order['id'], reason: string, revision: number) =>
  submitCommand({ _tag: 'RemoveDemoOrder', id, reason }, revision);
