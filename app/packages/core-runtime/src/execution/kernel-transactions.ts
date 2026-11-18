import { Context } from 'effect';
import type { Effect } from 'effect';

import type { TransactionAborted, TransactionFacts } from '../sdk/index.ts';
import type { OwnerServicesBinding, TransactionRequest } from './contract.ts';

/**
 * Opens one owner transaction and runs a module function in it (`execution/transaction.ts`).
 * Obligations, in this order inside one `CoreDatabase` transaction:
 *
 * 1. The first statement sets the mode: `SET TRANSACTION READ ONLY` (or `READ WRITE`) with the
 *    isolation the fence requires (READ COMMITTED), before any other statement, so the fence, the
 *    clock, the scope install and the owner rule all run under it.
 * 2. Fence: when `admittedRevision` is defined, `lockApplicationCompositionAuthority(tx, revision,
 *    'read')`; a failure is `TransactionAborted('composition_changed')`.
 * 3. `installOperationalScope(tx, scope)`, then `bindScopedWorkloadAdmission` with
 *    `workloadAdmission`; its `close` runs when the body ends.
 * 4. `trustedTransactionTime(tx)` gives `TransactionFacts.operationAt`.
 * 5. Owner rule: `OwnerAuthorizationOverlay.authorize(scoped, { ...owner, operationAt })`. `denied`
 *    fails `TransactionAborted('owner_denied')`, `unavailable` fails `'owner_unavailable'`. Decided
 *    in every transaction, before services exist.
 * 6. Services: `owner.build(scoped, scope, admittedRevision, listAccess)`. A failure is
 *    `TransactionAborted('database_unavailable')`.
 * 7. The body runs in a child scope; every fiber it forked is interrupted and awaited before the
 *    transaction settles, so no statement is in flight at COMMIT or ROLLBACK.
 * 8. The services and the scoped executor are revoked when the body ends: any later use dies
 *    `ExecutionRuleViolation('transaction_ended')`.
 * 9. Body success commits; any body failure, defect or interruption rolls back and is passed on
 *    unchanged. An SQL error of the opener itself (BEGIN, fence, scope, clock, COMMIT) is
 *    `TransactionAborted('database_unavailable')`.
 *
 * The read's evidence is not written here: the read adapter settles it after `run` (`ExecutionEvidence`).
 */
export interface KernelTransactionsService {
  readonly open: <Services, FactoryRequirements, A, E, R>(
    request: TransactionRequest,
    owner: OwnerServicesBinding<Services, FactoryRequirements>,
    body: (services: Services, facts: TransactionFacts) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | TransactionAborted, FactoryRequirements | R>;
}

export class KernelTransactions extends Context.Service<KernelTransactions, KernelTransactionsService>()(
  '@app/core-runtime/execution/kernel-transactions/KernelTransactions',
) {}
