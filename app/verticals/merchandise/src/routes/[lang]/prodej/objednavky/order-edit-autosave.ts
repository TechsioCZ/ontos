import { pendingProposalMessage } from '../../../../api/action-result.ts';
// Autosave of one order edit. `EditOrder` names the order version it was made against, so the form keeps the
// version its draft builds on, and after every save reads the version that save left behind.
import { useAutosaveDraft } from '@app/admin-ui';
import type { AutosaveOutcome, RevisionedSaveResult } from '@app/admin-ui';
import { DateTime, Effect, Predicate, Random } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Order } from '../../../../../shared/apis/records.ts';
import { executeRecords } from '../../../../api/records-consumer.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { draftOf, editCommandOf, sameOrderDraft } from './order-edit-draft.ts';
import type { Draft } from './order-edit-draft.ts';
import { editOrder } from './orders-records.ts';

export interface OrderVersion {
  readonly revision: number;
  readonly updatedAt: Order['updatedAt'];
}

type EditFailure = Effect.Error<ReturnType<typeof editOrder>>;
type RecordsFailure = Effect.Error<ReturnType<typeof executeRecords>>;

/** What the register answered about the order's version; a failed or missing read keeps the version we have. */
export type OrderVersionRead =
  | { readonly status: 'found'; readonly version: OrderVersion }
  | { readonly cause: RecordsFailure; readonly status: 'failed' }
  | { readonly status: 'missing' };

/** One order by id: the same read the detail uses, so the version is the one the next edit must name. */
export const readOrderVersion = (orderId: Order['id']): Effect.Effect<OrderVersionRead> =>
  Random.nextInt.pipe(
    Effect.map((draw) => `orders:version:${orderId}:${draw}`),
    Effect.flatMap((correlation) => executeRecords({ view: { limit: 0, orderId, ordersLimit: 1 } }, correlation)),
    Effect.map((response): OrderVersionRead => {
      const found = response.orders.find((order) => order.id === orderId);
      return found === undefined
        ? { status: 'missing' }
        : { status: 'found', version: { revision: response.revision, updatedAt: found.updatedAt } };
    }),
    Effect.match({
      onFailure: (cause): OrderVersionRead => ({ cause, status: 'failed' }),
      onSuccess: (read) => read,
    }),
  );

/** A conflict means someone else edited the order, so the panel offers their version instead of retrying blindly. */
const outcomeOf = (error: EditFailure): AutosaveOutcome =>
  Predicate.isTagged(error, 'ManageCatalogActionConflictProblem') && error.code === 'merchandise_revision_conflict'
    ? 'conflict'
    : 'failed';

/** The order version a saved edit left behind, or `saved` when it could not be read; otherwise why nothing was saved. */
export type OrderEditSaveResult = OrderVersion | AutosaveOutcome;

/**
 * Sends one order edit against `revision` and reads the version the server has afterwards, which the next change of
 * the same session builds on instead of conflicting with its own write. A version that could not be read answers
 * `saved`: the draft then keeps its base, and the next save asks the panel to load the current version instead of
 * guessing. `pending` gets the approval notice of a refused save and is cleared by a save that went through.
 */
export const saveOrderEdit = (
  command: Extract<MerchandiseCommand, { readonly _tag: 'EditOrder' }>,
  revision: number,
  pending?: (message: string | null) => void,
): Effect.Effect<OrderEditSaveResult> =>
  editOrder(command, revision).pipe(
    Effect.flatMap(() => readOrderVersion(command.id)),
    Effect.map((read): OrderEditSaveResult => {
      pending?.(null);
      return read.status === 'found' ? read.version : 'saved';
    }),
    Effect.match({
      onFailure: (error) => {
        pending?.(pendingProposalMessage(error) ?? null);
        return outcomeOf(error);
      },
      onSuccess: (outcome) => outcome,
    }),
  );

/** An order's own version as a number that only grows: the instant of its last change. */
const versionOf = (updatedAt: Order['updatedAt']): number => DateTime.toEpochMillis(updatedAt);

interface OrderEditAutosaveOptions {
  /** The form's own validation; an invalid draft is never sent. */
  readonly isValid: (value: Draft) => boolean;
  readonly order: Order;
  /** The catalog revision `order` was read at. */
  readonly revision: number;
}

/**
 * Draft and autosave of the order edit form. The form stays mounted while its order reloads (after its own save,
 * a live change, the freshness window), so the draft follows the order itself: an untouched draft takes the reloaded
 * order, a draft with unsaved changes stays and keeps naming the order version it was typed over. The server then
 * refuses the save when someone else changed the order meanwhile, instead of taking old lines over their change.
 *
 * The base the draft tracks is the order's own `updatedAt`, the precondition the server checks for an order edit;
 * the catalog revision moves with every other order and product too. Each save sends the pair read together.
 */
export const useOrderEditAutosave = ({ isValid, order, revision }: OrderEditAutosaveOptions) => {
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const savedOnce = useRef(false);
  // Every order version this form has seen, by its instant: a kept draft still names the one it was typed over.
  const versions = useRef(new Map<number, OrderVersion>());
  const { updatedAt } = order;
  useEffect(() => {
    const key = versionOf(updatedAt);
    if (!versions.current.has(key)) {
      versions.current.set(key, { revision, updatedAt });
    }
  }, [revision, updatedAt]);
  const autosave = useAutosaveDraft<Draft, never>({
    equals: sameOrderDraft,
    isValid,
    revision: versionOf(updatedAt),
    runtime: browserRuntime,
    save: (value, expectedVersion, confirmed): Effect.Effect<RevisionedSaveResult> => {
      const base = versions.current.get(expectedVersion) ?? { revision, updatedAt };
      const command = editCommandOf(order, base.updatedAt, value, confirmed);
      return command === null
        ? Effect.succeed('saved')
        : saveOrderEdit(command, base.revision, setPendingMessage).pipe(
            Effect.map((result): RevisionedSaveResult => {
              if (result === 'conflict' || result === 'failed' || result === 'proposed') {
                return result;
              }
              savedOnce.current = true;
              if (result === 'saved') {
                return result;
              }
              versions.current.set(versionOf(result.updatedAt), result);
              return versionOf(result.updatedAt);
            }),
          );
    },
    server: draftOf(order),
  });
  return { autosave, pendingMessage, savedOnce };
};
