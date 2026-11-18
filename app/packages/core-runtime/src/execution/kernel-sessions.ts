import { Context } from 'effect';
import type { Effect, Scope } from 'effect';

import type { DeclaredCalls } from '../sdk/index.ts';
import type { KernelExecution, KernelSession, OwnerServicesBinding } from './contract.ts';

/**
 * Opens the kernel session of one execution (`execution/runner.ts`). Obligations:
 *
 * - Keeps one ledger per session: open-transaction flag, in-flight call count, call count,
 *   transaction count, start time, whether any transaction has ended (for `Placement`), call records.
 * - `capabilities.transaction(body)`: if a transaction is open, `Effect.die(ExecutionRuleViolation
 *   'nested_transaction')`; if a call of this session is still in flight (module code forked it),
 *   die `call_inside_transaction`. If the budget is spent, fail
 *   `TransactionAborted('budget_exhausted')`. Otherwise mark open, run
 *   `KernelTransactions.open` with `sequence` = count + 1, and clear the flag when it ends in any way
 *   (success, failure, defect, interruption).
 * - `capabilities.call(name, ...args)`: if a transaction is open, die `call_inside_transaction`. If
 *   `name` is not an own key of `execution.calls`, die `undeclared_call`. If the budget is spent,
 *   answer `Unavailable` (`retryable: false`) and record it. Otherwise hand the declared call, the
 *   input, the idempotency key (write calls only), the placement (`before` until a transaction has
 *   ended, then `after`) and the sequence to `KernelCalls.execute`, record its record, return its
 *   outcome.
 * - Calls may run concurrently with each other (`Effect.forEach` with concurrency in module code).
 *   The two checks above are made atomically against the ledger.
 * - Closing the scope closes the session: any later use of a capability dies
 *   `capability_after_execution`; an open transaction is interrupted, which rolls it back.
 * - `capabilities.execution` is `execution.facts` unchanged.
 */
export interface KernelSessionsService {
  readonly open: <Services, Calls extends DeclaredCalls, Requirements>(
    execution: KernelExecution<Calls>,
    owner: OwnerServicesBinding<Services, Requirements>,
  ) => Effect.Effect<KernelSession<Services, Calls>, never, Scope.Scope>;
}

export class KernelSessions extends Context.Service<KernelSessions, KernelSessionsService>()(
  '@app/core-runtime/execution/kernel-sessions/KernelSessions',
) {}
