import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CallExecution, CallExecutionRequest } from './contract.ts';

/**
 * Runs one declared call (`execution/call.ts`). Never fails: every failure is an outcome. Obligations,
 * in order:
 *
 * 1. Requirement: `CallRequirements.resolve(declared.requirementKey, declared.operation, principal)`.
 *    Unresolved is `Unavailable` (`retryable` exactly for `lease_mismatch`).
 * 2. Caller: `selectCaller(identity, resolved.callers, recoveryRequestHash)`, where the hash is
 *    `computeCanonicalValueHash(input)` exactly when the identity is a recovery request. Not permitted
 *    is `Forbidden` with `callerKind: 'refused'`. Never another caller kind.
 * 3. Request: `Schema.encodeUnknownEffect(operation.request)(input)`; a failure is `Unavailable`
 *    (`retryable: false`).
 * 4. Route: `Core` goes to `CoreCallRoute`, `Module` to `ModuleCallRoute` (optional service); an absent module route is
 *    `Unavailable` (`retryable: false`).
 * 5. Answer: `Answered` is decoded with `Schema.decodeUnknownEffect(operation.response)`; a decode
 *    failure is `Unavailable` (`retryable: false`). `Problem` maps by status: 404 `NotFound`; 401 and
 *    403 `Forbidden`; 409 and 422 `Rejected` with the problem code; 503 `Unavailable(true)`; any other
 *    status `Unavailable(false)`. `Unreachable` is `Unavailable(true)`.
 * 6. Write calls (reserved): the idempotency key is sent; 2xx is `Committed`, a problem the provider
 *    marks as a committed refusal is `CommittedRejection`, a 4xx refused before acceptance is
 *    `DefinitelyUncommitted`, anything else `Indeterminate`. Reads refuse write calls at definition.
 * 7. One `CallRecord` with timing; logged with the scope's correlation id, never the payload.
 */
export interface KernelCallsService {
  readonly execute: (request: CallExecutionRequest) => Effect.Effect<CallExecution>;
}

export class KernelCalls extends Context.Service<KernelCalls, KernelCallsService>()(
  '@app/core-runtime/execution/kernel-calls/KernelCalls',
) {}
