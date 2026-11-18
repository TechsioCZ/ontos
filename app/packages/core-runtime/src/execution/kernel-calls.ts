import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CallExecution, CallExecutionRequest } from './contract.ts';

/**
 * Runs one declared read call (`execution/call.ts`). Never fails: every failure is an outcome.
 * Obligations, in order:
 *
 * 1. Requirement: `CallRequirements.resolve(declared.requirementKey, declared.operation,
 *    execution.callerSource)`. Unresolved is `Unavailable` (`retryable` exactly for `lease_mismatch`).
 * 2. Caller: a Core provider (`provider.moduleId` starts with `core.`) is `{ kind: 'in_process' }`
 *    without selection. Otherwise `selectCaller(identity, resolved.callers, { principalId,
 *    recoveryRequestHash })`, where the hash is `computeCanonicalValueHash(input)` exactly when the
 *    identity is a recovery request. Not permitted is `Forbidden` with `callerKind: 'refused'`. Never
 *    another caller kind.
 * 3. Request: `Schema.encodeUnknownEffect(operation.request)(input)`; a failure is `Unavailable`
 *    (`retryable: false`).
 * 4. Route: `Core` goes to `CoreCallRoute`, `Module` to `ModuleCallRoute`, read with
 *    `Effect.serviceOption`; absent, it dies `ExecutionRuleViolation('module_call_without_route')`
 *    (the read runtime refuses to start a host whose reads declare module calls without a route, so
 *    this is unreachable in a correctly built host).
 * 5. Answer: `Answered` is decoded with `Schema.decodeUnknownEffect(operation.response)`; a decode
 *    failure is `Unavailable` (`retryable: false`). `Problem` maps by status: 404 `NotFound`; 401 and
 *    403 `Forbidden`; 409 and 422 `Rejected` with the problem code; 503 `Unavailable(true)`; any other
 *    status `Unavailable(false)`. `Unreachable` is `Unavailable(true)`.
 * 6. One `CallRecord` with timing; logged with the scope's correlation id, never the payload.
 *
 * Write calls never reach it: the session dies `write_call_reserved` first. The Action adapter will
 * define their outcome mapping together with a provider marker for a committed refusal.
 */
export interface KernelCallsService {
  readonly execute: (request: CallExecutionRequest) => Effect.Effect<CallExecution>;
}

export class KernelCalls extends Context.Service<KernelCalls, KernelCallsService>()(
  '@app/core-runtime/execution/kernel-calls/KernelCalls',
) {}
