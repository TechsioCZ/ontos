import { pendingProposalMessage } from '../../../../api/action-result.ts';
// Autosave of one order edit. `EditOrder` names the order version it was made against, so after every save the
// version the next save must name is read again from the register.
import type { AutosaveOutcome } from '@app/admin-ui';
import { Effect, Predicate, Random } from 'effect';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Order } from '../../../../../shared/apis/records.ts';
import { executeRecords } from '../../../../api/records-consumer.ts';
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

/**
 * Sends one order edit and moves the tracked version to the one the server now has, so the next change of the same
 * session builds on it instead of conflicting with its own write. A version that could not be read is kept, and the
 * next save then asks the panel to load the current version instead of guessing.
 */
export const saveOrderEdit = (
  command: Extract<MerchandiseCommand, { readonly _tag: 'EditOrder' }>,
  version: { current: OrderVersion },
  pending?: (message: string | null) => void,
): Effect.Effect<AutosaveOutcome> =>
  editOrder(command, version.current.revision).pipe(
    Effect.flatMap(() => readOrderVersion(command.id)),
    Effect.map((read): AutosaveOutcome => {
      if (read.status === 'found') {
        version.current = read.version;
      }
      return 'saved';
    }),
    Effect.match({
      onFailure: (error) => {
        pending?.(pendingProposalMessage(error) ?? null);
        return outcomeOf(error);
      },
      onSuccess: (outcome) => outcome,
    }),
  );
