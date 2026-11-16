import { Effect } from 'effect';

import type { AccessDecision } from '../access/decision/contract.ts';
import { accessDecisionUnavailable } from '../access/decision/errors.ts';
import type { AccessDecisionUnavailable } from '../access/decision/errors.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { CoreTransaction } from '../db/types.ts';
import type { PreparedAccessDecision } from '../operations/access-gate.ts';

/**
 * The Action transaction's scoped executor, carrying the capability to re-decide a prepared gate question from its own
 * snapshot (`recheckPreparedAccess`). It closes over the raw transaction, which the owner never receives.
 */
export const withPreparedAccessRecheck = (
  scoped: ScopedTransactionExecutor,
  transaction: CoreTransaction,
): ScopedTransactionExecutor =>
  Object.freeze({
    ...scoped,
    recheckPreparedAccess: (prepared: PreparedAccessDecision, now: Date) => prepared.recheck(now, transaction),
  });

/**
 * Re-decides a prepared gate question inside the Action transaction `scoped` belongs to. An executor the Action
 * runtime did not issue, or a revision that changed since the question was prepared, is UNAVAILABLE: never the stale
 * answer.
 */
export const recheckPreparedAccessIn = (
  prepared: PreparedAccessDecision,
  now: Date,
  scoped: ScopedTransactionExecutor,
): Effect.Effect<AccessDecision, AccessDecisionUnavailable> =>
  scoped.recheckPreparedAccess === undefined
    ? Effect.fail(accessDecisionUnavailable('The prepared question has no Action transaction to be re-checked in'))
    : scoped.recheckPreparedAccess(prepared, now);
