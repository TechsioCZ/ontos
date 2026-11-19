import { Context } from 'effect';
import type { Effect, Scope } from 'effect';

import type { DeclaredCalls, ExecutionIdentity, TransactionAborted } from '../sdk/index.ts';
import type { KernelExecution, KernelSession, OwnerBinding } from './contract.ts';

/**
 * Opens the kernel session of one execution (`execution/runner.ts`). Obligations:
 *
 * - Captures `Effect.context<Requirements>()` when it opens and provides it to every
 *   `KernelTransactions.open`, so `capabilities.transaction` needs only the body's own requirements.
 * - Authority before module code: decides the owner rule once with `KernelTransactions.checkOwner`
 *   (sequence 0) before returning the session, so a `{ run }` read with no transaction, or one that
 *   calls first, never runs module code or a call for an execution its owner rule denies. Its failure
 *   (`owner_denied`, `owner_unavailable`, `composition_changed`, `database_unavailable`) is the failure
 *   of `open`; no session exists then.
 * - Keeps one ledger per session: open-transaction flag, in-flight call count, call count,
 *   transaction count, start time, whether any transaction has ended (for `Placement`), the sticky
 *   owner denial, call records.
 * - `capabilities.transaction(body)`: if a transaction is open, `Effect.die(ExecutionRuleViolation
 *   'nested_transaction')`; if a call of this session is still in flight (module code forked it),
 *   die `call_inside_transaction`. If the ledger holds an owner denial, fail
 *   `TransactionAborted('owner_denied')` without opening one. If the budget is spent, fail
 *   `TransactionAborted('budget_exhausted')`. Otherwise mark open, run `KernelTransactions.open` with
 *   `sequence` = count + 1, record an owner denial in the ledger when the owner rule answers it (so a
 *   failing rollback cannot lose it; the transaction then fails `TransactionAborted('owner_denied')`),
 *   and clear the open flag when it ends in any way (success, failure, defect, interruption).
 * - `capabilities.call(name, ...args)`: if a transaction is open, die `call_inside_transaction`. If
 *   `name` is not an own key of `execution.calls`, die `undeclared_call`. If the declared call is a
 *   write call, die `write_call_reserved`. If the ledger holds an owner denial, answer `Forbidden`
 *   without leaving the process and record it (`callerKind: 'refused'`). If the budget is spent,
 *   answer `Unavailable` (`retryable: false`) and record it. Otherwise hand the declared call, the
 *   input, the placement (`before` until a transaction has ended, then `after`) and the sequence to
 *   `KernelCalls.execute`, record its record, return its outcome.
 * - Calls may run concurrently with each other (`Effect.forEach` with concurrency in module code).
 *   The checks above are made atomically against the ledger.
 * - `settle` (and closing the scope) closes the session: any later use of a capability dies
 *   `capability_after_execution`; an open transaction is interrupted, which rolls it back; a call in
 *   flight is interrupted and recorded `Interrupted`.
 * - `capabilities.execution` is `execution.facts` unchanged.
 */
interface KernelSessionsService {
  readonly open: <Services, Calls extends DeclaredCalls, Requirements, Identity extends ExecutionIdentity>(
    execution: KernelExecution<Calls, Identity>,
    owner: OwnerBinding<Services, Requirements>,
  ) => Effect.Effect<KernelSession<Services, Calls, Identity>, TransactionAborted, Requirements | Scope.Scope>;
}

export class KernelSessions extends Context.Service<KernelSessions, KernelSessionsService>()(
  '@app/core-runtime/execution/kernel-sessions/KernelSessions',
) {}
