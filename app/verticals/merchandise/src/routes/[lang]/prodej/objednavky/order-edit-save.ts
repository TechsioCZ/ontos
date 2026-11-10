import { pendingProposalMessage } from '../../../../api/action-result.ts';
// Save of one order edit. `EditOrder` names the order version it was made against, so the form keeps the
// version its draft builds on, and after every save reads the version that save left behind.
import { useRecordDraft } from '@app/admin-ui';
import type { SaveOutcome, RevisionedSaveResult } from '@app/admin-ui';
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
  | { readonly order: Order; readonly status: 'found'; readonly version: OrderVersion }
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
        : { order: found, status: 'found', version: { revision: response.revision, updatedAt: found.updatedAt } };
    }),
    Effect.match({
      onFailure: (cause): OrderVersionRead => ({ cause, status: 'failed' }),
      onSuccess: (read) => read,
    }),
  );

/**
 * Why an edit wrote nothing. A conflict means someone else edited the order, so the form offers their version
 * instead of sending the same edit again; an edit parked for approval is held and never sent again.
 */
const outcomeOf = (error: EditFailure): SaveOutcome => {
  if (pendingProposalMessage(error) !== undefined) {
    return 'proposed';
  }
  return Predicate.isTagged(error, 'ManageCatalogActionConflictProblem') &&
    error.code === 'merchandise_revision_conflict'
    ? 'conflict'
    : 'failed';
};

/**
 * The order version a saved edit left behind, or `saved` when that version is not known; otherwise why nothing was
 * saved.
 */
export type OrderEditSaveResult = OrderVersion | SaveOutcome;

/**
 * Sends one order edit against `revision` and reads the version the server has afterwards, which the next change of
 * the same session builds on instead of conflicting with its own write.
 *
 * The read-back is that version only while the order still is what this edit left (`isWritten`). An edit by
 * someone else that landed between the save and the read-back is in the read order too: taking its version as the
 * base would let the next save put this form's older lines over their change. Such a read, like one that failed,
 * answers `saved`: the draft keeps its base, and the next save is refused and offers the current version instead of
 * guessing.
 */
export const saveOrderEdit = (
  command: Extract<MerchandiseCommand, { readonly _tag: 'EditOrder' }>,
  revision: number,
  isWritten: (order: Order) => boolean,
): Effect.Effect<OrderEditSaveResult> =>
  editOrder(command, revision).pipe(
    Effect.flatMap(() => readOrderVersion(command.id)),
    Effect.map((read): OrderEditSaveResult =>
      read.status === 'found' && isWritten(read.order) ? read.version : 'saved',
    ),
    Effect.match({ onFailure: outcomeOf, onSuccess: (outcome) => outcome }),
  );

/** An order's own version as a number that only grows: the instant of its last change. */
const versionOf = (updatedAt: Order['updatedAt']): number => DateTime.toEpochMillis(updatedAt);

interface OrderEditDraftOptions {
  /**
   * The form's own validation; an invalid draft is never sent. `confirmed` is the draft the edit is compared with
   * (`editCommandOf`), so the rule for an edited address or contact uses the base the sent command uses.
   */
  readonly isValid: (value: Draft, confirmed: Draft) => boolean;
  readonly order: Order;
  /** The catalog revision `order` was read at. */
  readonly revision: number;
}

/**
 * Draft and save of the order edit form. Nothing is sent until `record.save()`, the form's Save button. The form
 * stays mounted while its order reloads (after its own save, a live change, the freshness window), so the draft
 * follows the order itself: an untouched draft takes the reloaded order, a draft with unsaved changes stays and keeps
 * naming the order version it was typed over. The server then refuses the save when someone else changed the order
 * meanwhile, instead of taking old lines over their change.
 * A change reason typed for the next edit is no unsaved change of the order, so it stays in the field when the draft
 * takes a reloaded order.
 *
 * The base the draft tracks is the order's own `updatedAt`, the precondition the server checks for an order edit;
 * the catalog revision moves with every other order and product too. Each save sends the pair read together. After a
 * save the base moves to the version read back only when that order is what the save wrote (`saveOrderEdit`).
 */
export const useOrderEditDraft = ({ isValid, order, revision }: OrderEditDraftOptions) => {
  // The change reason that went into the history with the last saved edit: the reload after that save clears it
  // from the field, while a reason still waiting for its edit stays.
  const [sentReason, setSentReason] = useState<string | null>(null);
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
  const record = useRecordDraft<Draft, never>({
    equals: sameOrderDraft,
    isValid,
    revision: versionOf(updatedAt),
    runtime: browserRuntime,
    save: (value, expectedVersion, confirmed): Effect.Effect<RevisionedSaveResult> => {
      const base = versions.current.get(expectedVersion) ?? { revision, updatedAt };
      const command = editCommandOf(order, base.updatedAt, value, confirmed);
      // The register stores no change reason on the order, so the order this save leaves is the draft without it.
      const written = { ...value, reason: '' };
      const isWritten = (read: Order) => sameOrderDraft(draftOf(read), written);
      return command === null
        ? Effect.succeed('saved')
        : saveOrderEdit(command, base.revision, isWritten).pipe(
            Effect.map((result): RevisionedSaveResult => {
              if (result === 'conflict' || result === 'failed' || result === 'proposed') {
                return result;
              }
              savedOnce.current = true;
              setSentReason(command.reason ?? null);
              if (result === 'saved') {
                return result;
              }
              versions.current.set(versionOf(result.updatedAt), result);
              return versionOf(result.updatedAt);
            }),
          );
    },
    server: draftOf(order),
    // The register keeps no reason on the order, so the reloaded order never carries the one being typed.
    takeServer: (server, current) =>
      current.reason.trim() === '' || current.reason.trim() === sentReason
        ? server
        : { ...server, reason: current.reason },
  });
  // Once the field no longer holds the reason that was sent, the same words typed again are a new reason.
  if (sentReason !== null && record.draft.reason.trim() !== sentReason) {
    setSentReason(null);
  }
  return { record, savedOnce };
};
