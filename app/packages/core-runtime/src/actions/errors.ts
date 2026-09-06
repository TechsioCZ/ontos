/* eslint-disable max-classes-per-file -- The public Core error union is intentionally co-located and exhaustive. */
import { Schema } from 'effect';
import type {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
} from '../modules/module-state-gate-errors.ts';
import type { OperationContextError } from '../operations/errors.ts';

const safeReason = {
  reason: Schema.String,
} as const;

export class ActionPayloadValidationError extends Schema.TaggedError<ActionPayloadValidationError>()(
  'ActionPayloadValidationError',
  {
    code: Schema.Literal('action_payload_invalid'),
    ...safeReason,
  },
) {}

export class ActionResultValidationError extends Schema.TaggedError<ActionResultValidationError>()(
  'ActionResultValidationError',
  {
    code: Schema.Literal('action_result_invalid'),
    ...safeReason,
  },
) {}

export class ActionTrustedContextValidationError extends Schema.TaggedError<ActionTrustedContextValidationError>()(
  'ActionTrustedContextValidationError',
  {
    code: Schema.Literal('action_trusted_context_invalid'),
    ...safeReason,
  },
) {}

export class ActionIdempotencyKeyRequired extends Schema.TaggedError<ActionIdempotencyKeyRequired>()(
  'ActionIdempotencyKeyRequired',
  {
    code: Schema.Literal('action_idempotency_key_required'),
    ...safeReason,
  },
) {}

export class ActionPermissionDenied extends Schema.TaggedError<ActionPermissionDenied>()(
  'ActionPermissionDenied',
  {
    code: Schema.Literal('action_permission_denied'),
    ...safeReason,
  },
) {}

export class ActionPermissionCheckError extends Schema.TaggedError<ActionPermissionCheckError>()(
  'ActionPermissionCheckError',
  {
    code: Schema.Literal('action_permission_check_failed'),
    ...safeReason,
  },
) {}

export class ActionAlreadyCommitted extends Schema.TaggedError<ActionAlreadyCommitted>()(
  'ActionAlreadyCommitted',
  {
    code: Schema.Literal('action_already_committed'),
    invocationId: Schema.String,
    ...safeReason,
  },
) {}

export class ActionRequestHashConflict extends Schema.TaggedError<ActionRequestHashConflict>()(
  'ActionRequestHashConflict',
  {
    code: Schema.Literal('action_request_hash_conflict'),
    ...safeReason,
  },
) {}

// Module-private capability: only this module can hand it to the reader below, so the retained
// cause stays in a private field that neither reflection nor other packages can reach.
const persistenceCauseAccess = Symbol('ActionInvocationPersistenceError.retainedCause');

export class ActionInvocationPersistenceError extends Schema.TaggedError<ActionInvocationPersistenceError>()(
  'ActionInvocationPersistenceError',
  {
    code: Schema.Literal('action_invocation_persistence_failed'),
    ...safeReason,
  },
) {
  #persistenceCause: unknown = undefined;

  static withCause<FailureCause>(
    reason: string,
    cause?: FailureCause,
  ): ActionInvocationPersistenceError {
    const failure = new ActionInvocationPersistenceError({
      code: 'action_invocation_persistence_failed',
      reason,
    });
    failure.#persistenceCause = cause;
    return failure;
  }

  /**
   * Returns nothing without the module-private capability.
   *
   * @internal
   */
  static retainedCause(
    access: typeof persistenceCauseAccess,
    failure: ActionInvocationPersistenceError,
  ): unknown {
    return access === persistenceCauseAccess ? failure.#persistenceCause : undefined;
  }

  static {
    // Not writable or configurable: nothing can swap the factory to capture a raw cause, or the
    // reader to intercept the capability.
    for (const name of ['withCause', 'retainedCause']) {
      Object.defineProperty(this, name, { configurable: false, writable: false });
    }
  }
}

/** @internal */
export const getActionInvocationPersistenceErrorCause = (
  failure: ActionInvocationPersistenceError,
): unknown => ActionInvocationPersistenceError.retainedCause(persistenceCauseAccess, failure);

export class ActionInvocationNotFound extends Schema.TaggedError<ActionInvocationNotFound>()(
  'ActionInvocationNotFound',
  {
    code: Schema.Literal('action_invocation_not_found'),
    ...safeReason,
  },
) {}

export class ActionInvocationStateError extends Schema.TaggedError<ActionInvocationStateError>()(
  'ActionInvocationStateError',
  {
    code: Schema.Literal('action_invocation_state_invalid'),
    ...safeReason,
  },
) {}

export class ActionCollectorError extends Schema.TaggedError<ActionCollectorError>()(
  'ActionCollectorError',
  {
    code: Schema.Literal('action_collector_invalid'),
    ...safeReason,
  },
) {
  #cause: unknown | undefined = undefined;

  static withCause(reason: string, cause: unknown): ActionCollectorError {
    const failure = new ActionCollectorError({
      code: 'action_collector_invalid',
      reason,
    });
    failure.#cause = cause;
    return failure;
  }

  static getCause(failure: ActionCollectorError): unknown | undefined {
    return failure.#cause;
  }
}

export class ActionHandlerExecutionError extends Schema.TaggedError<ActionHandlerExecutionError>()(
  'ActionHandlerExecutionError',
  {
    code: Schema.Literal('action_handler_execution_failed'),
    ...safeReason,
  },
) {}

export class ActionPolicyDenied extends Schema.TaggedError<ActionPolicyDenied>()(
  'ActionPolicyDenied',
  {
    code: Schema.Literal('action_policy_denied'),
    policyReasonCode: Schema.String,
    ...safeReason,
  },
) {}

export class ActionPolicyEvaluationError extends Schema.TaggedError<ActionPolicyEvaluationError>()(
  'ActionPolicyEvaluationError',
  {
    code: Schema.Literal('action_policy_evaluation_failed'),
    ...safeReason,
  },
) {}

// Module-private capability: only this module can hand it to the reader below, so the retained
// cause stays in a private field that neither reflection nor other packages can reach.
const transactionCauseAccess = Symbol('ActionTransactionError.retainedCause');

export class ActionTransactionError extends Schema.TaggedError<ActionTransactionError>()(
  'ActionTransactionError',
  {
    code: Schema.Literal('action_transaction_failed'),
    ...safeReason,
  },
) {
  #transactionCause: unknown = undefined;

  static withCause<FailureCause>(reason: string, cause?: FailureCause): ActionTransactionError {
    const failure = new ActionTransactionError({
      code: 'action_transaction_failed',
      reason,
    });
    failure.#transactionCause = cause;
    return failure;
  }

  /**
   * Returns nothing without the module-private capability.
   *
   * @internal
   */
  static retainedCause(
    access: typeof transactionCauseAccess,
    failure: ActionTransactionError,
  ): unknown {
    return access === transactionCauseAccess ? failure.#transactionCause : undefined;
  }

  static {
    // Not writable or configurable: nothing can swap the factory to capture a raw cause, or the
    // reader to intercept the capability.
    for (const name of ['withCause', 'retainedCause']) {
      Object.defineProperty(this, name, { configurable: false, writable: false });
    }
  }
}

/** @internal */
export const getActionTransactionErrorCause = (failure: ActionTransactionError): unknown =>
  ActionTransactionError.retainedCause(transactionCauseAccess, failure);

export class ActionCommitIndeterminate extends Schema.TaggedError<ActionCommitIndeterminate>()(
  'ActionCommitIndeterminate',
  {
    code: Schema.Literal('action_commit_indeterminate'),
    invocationId: Schema.String,
    ...safeReason,
  },
) {}

export type ActionCoreError =
  | ActionAlreadyCommitted
  | ActionCollectorError
  | ActionCommitIndeterminate
  | ActionHandlerExecutionError
  | ActionIdempotencyKeyRequired
  | ActionInvocationNotFound
  | ActionInvocationPersistenceError
  | ActionInvocationStateError
  | ActionPermissionCheckError
  | ActionPermissionDenied
  | ActionPayloadValidationError
  | ActionPolicyDenied
  | ActionPolicyEvaluationError
  | ActionRequestHashConflict
  | ActionResultValidationError
  | ActionTransactionError
  | ActionTrustedContextValidationError
  | ModuleStateCheckUnavailableError
  | ModuleStateDeniedError
  | OperationContextError;

/**
 * Core errors are transport-neutral. A BFF must map this union and the
 * registration's declared domain errors exhaustively to its public schemas.
 * Structural payload/metadata validation maps to 400, invalid trusted
 * authentication context to 401, a missing required idempotency key to 428,
 * permission denial to 403, idempotency and terminal-state conflicts to 409,
 * missing invocations to 404, and permission-check failure, temporarily
 * unavailable persistence, Policy evaluation capability, and indeterminate
 * commit failures to an appropriate retryable status such as 503. Policy
 * denials map according to their declared business semantics (for example 403,
 * 409, or 422), never through one universal Policy status. Invalid results and
 * sanitized unexpected execution/transaction defects map to a declared safe
 * 500.
 */
export const ACTION_CORE_ERROR_TAGS = [
  'ActionPayloadValidationError',
  'ActionResultValidationError',
  'ActionTrustedContextValidationError',
  'ActionIdempotencyKeyRequired',
  'ActionPermissionDenied',
  'ActionPermissionCheckError',
  'ActionAlreadyCommitted',
  'ActionRequestHashConflict',
  'ActionInvocationNotFound',
  'ActionInvocationPersistenceError',
  'ActionInvocationStateError',
  'ActionCollectorError',
  'ActionHandlerExecutionError',
  'ActionPolicyDenied',
  'ActionPolicyEvaluationError',
  'ActionTransactionError',
  'ActionCommitIndeterminate',
  'ModuleStateDeniedError',
  'ModuleStateCheckUnavailableError',
] as const;
