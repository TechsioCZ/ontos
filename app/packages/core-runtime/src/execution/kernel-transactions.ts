import { Context } from 'effect';
import type { Effect } from 'effect';

import type { TransactionAborted, TransactionFacts } from '../sdk/index.ts';
import type { OwnerBinding, TransactionRequest } from './contract.ts';

/**
 * Opens one owner transaction and runs a module function in it (`execution/transaction.ts`).
 * Obligations, in this order inside one `CoreDatabase` transaction:
 *
 * 1. The mode is the execution's `transactionMode`. `session_default` is a plain BEGIN, exactly as
 *    main opens a read transaction; `read_only` and `read_write` pass the driver's transaction config,
 *    which emits it as the first statements after BEGIN: `executor.transaction(body, { accessMode:
 *    'read only' | 'read write', isolationLevel: 'read committed' })`. The fence, the clock, the scope
 *    install (including `trust.establish_gateway_scope` for a gateway-grant role), the seal and the
 *    owner rule all run under it.
 * 2. Fence: when `facts.compositionRevision` is defined, `lockApplicationCompositionAuthority(tx, revision,
 *    'read')` (`'write'` for `read_write`), which also requires READ COMMITTED; a failure is
 *    `TransactionAborted('composition_changed')`.
 * 3. `installOperationalScope(tx, scope)`, then `owner.seal`; its `close` runs when the body ends.
 * 4. Clock: `statement_timestamp()` of one statement issued now (a new helper next to
 *    `trustedTransactionTime` in `operations/transaction-time.ts`) is `TransactionFacts.operationAt`:
 *    after the fence wait, never earlier than it.
 * 5. Owner rule: `owner.decide(sealed, operationAt)`. `denied` fails `TransactionAborted('owner_denied')`,
 *    `unavailable` fails `'owner_unavailable'`. Decided in every transaction, before services exist.
 * 6. Services: `owner.build(sealed, scope, facts.compositionRevision)`. A failure is
 *    `TransactionAborted('database_unavailable')`.
 * 7. The body runs in a child scope; every fiber it forked is interrupted and awaited before the
 *    transaction settles, so no statement is in flight at COMMIT or ROLLBACK.
 * 8. The services and the scoped executor are revoked when the body ends: any later use dies
 *    `ExecutionRuleViolation('transaction_ended')`.
 * 9. Body success commits; any body failure, defect or interruption rolls back and is passed on
 *    unchanged. An SQL error of the opener itself (BEGIN, fence, scope, clock, COMMIT) is
 *    `TransactionAborted('database_unavailable')`.
 *
 * `checkOwner` is steps 1 to 5 with nothing after them, then ROLLBACK: the opening owner check of a
 * session. Neither writes evidence: the kind adapter settles it after the module's code.
 */
export interface KernelTransactionsService {
  readonly checkOwner: (
    request: TransactionRequest,
    owner: Pick<OwnerBinding<unknown, never>, 'decide' | 'seal'>,
  ) => Effect.Effect<void, TransactionAborted>;
  readonly open: <Services, FactoryRequirements, A, E, R>(
    request: TransactionRequest,
    owner: OwnerBinding<Services, FactoryRequirements>,
    body: (services: Services, facts: TransactionFacts) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | TransactionAborted, FactoryRequirements | R>;
}

export class KernelTransactions extends Context.Service<KernelTransactions, KernelTransactionsService>()(
  '@app/core-runtime/execution/kernel-transactions/KernelTransactions',
) {}
