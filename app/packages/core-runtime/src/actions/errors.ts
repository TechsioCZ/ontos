import { Cause, Schema } from 'effect';

import type { ModuleStateCheckUnavailableError, ModuleStateDeniedError } from '../modules/module-state-gate-errors.ts';
import type { OperationContextError } from '../operations/errors.ts';
import { actionErrorSchema } from './error-schema.ts';
import type { ActionTransactionError } from './transaction-error.ts';

export { ActionTransactionError } from './transaction-error.ts';

const safeReason = {
  reason: Schema.String,
} as const;

const ActionInvocationIdSchema = Schema.String.pipe(Schema.brand('ActionInvocationId'), Schema.decodeTo(Schema.String));

const ActionPayloadValidationErrorValue = actionErrorSchema('ActionPayloadValidationError', {
  code: Schema.Literal('action_payload_invalid'),
  ...safeReason,
});
export type ActionPayloadValidationError = InstanceType<typeof ActionPayloadValidationErrorValue>;
export { ActionPayloadValidationErrorValue as ActionPayloadValidationError };

const ActionResultValidationErrorValue = actionErrorSchema('ActionResultValidationError', {
  code: Schema.Literal('action_result_invalid'),
  ...safeReason,
});
export type ActionResultValidationError = InstanceType<typeof ActionResultValidationErrorValue>;
export { ActionResultValidationErrorValue as ActionResultValidationError };

const ActionTrustedContextValidationErrorValue = actionErrorSchema('ActionTrustedContextValidationError', {
  code: Schema.Literal('action_trusted_context_invalid'),
  ...safeReason,
});
export type ActionTrustedContextValidationError = InstanceType<typeof ActionTrustedContextValidationErrorValue>;
export { ActionTrustedContextValidationErrorValue as ActionTrustedContextValidationError };

const ActionIdempotencyKeyRequiredValue = actionErrorSchema('ActionIdempotencyKeyRequired', {
  code: Schema.Literal('action_idempotency_key_required'),
  ...safeReason,
});
export type ActionIdempotencyKeyRequired = InstanceType<typeof ActionIdempotencyKeyRequiredValue>;
export { ActionIdempotencyKeyRequiredValue as ActionIdempotencyKeyRequired };

const ActionPermissionDeniedValue = actionErrorSchema('ActionPermissionDenied', {
  code: Schema.Literal('action_permission_denied'),
  ...safeReason,
});
export type ActionPermissionDenied = InstanceType<typeof ActionPermissionDeniedValue>;
export { ActionPermissionDeniedValue as ActionPermissionDenied };

const ActionPermissionCheckErrorValue = actionErrorSchema('ActionPermissionCheckError', {
  code: Schema.Literal('action_permission_check_failed'),
  ...safeReason,
});
export type ActionPermissionCheckError = InstanceType<typeof ActionPermissionCheckErrorValue>;
export { ActionPermissionCheckErrorValue as ActionPermissionCheckError };

const ActionAlreadyCommittedValue = actionErrorSchema('ActionAlreadyCommitted', {
  code: Schema.Literal('action_already_committed'),
  invocationId: ActionInvocationIdSchema,
  ...safeReason,
});
export type ActionAlreadyCommitted = InstanceType<typeof ActionAlreadyCommittedValue>;
export { ActionAlreadyCommittedValue as ActionAlreadyCommitted };

const ActionRequestHashConflictValue = actionErrorSchema('ActionRequestHashConflict', {
  code: Schema.Literal('action_request_hash_conflict'),
  ...safeReason,
});
export type ActionRequestHashConflict = InstanceType<typeof ActionRequestHashConflictValue>;
export { ActionRequestHashConflictValue as ActionRequestHashConflict };

const ActionInvocationPersistenceErrorValue = actionErrorSchema('ActionInvocationPersistenceError', {
  code: Schema.Literal('action_invocation_persistence_failed'),
  ...safeReason,
});
export type ActionInvocationPersistenceError = InstanceType<typeof ActionInvocationPersistenceErrorValue>;
const ActionInvocationPersistenceErrorInternals = (() => {
  let createWithCause: (
    props: ConstructorParameters<typeof ActionInvocationPersistenceErrorValue>[0],
    cause?: unknown,
  ) => ActionInvocationPersistenceError;
  let readCause: (failure: ActionInvocationPersistenceError) => Cause.Cause<never> | undefined;

  class RetainedError extends ActionInvocationPersistenceErrorValue {
    #cause: Cause.Cause<never> | undefined;

    static {
      createWithCause = (props, cause) => {
        const failure = new RetainedError(props);
        if (cause !== undefined) {
          failure.#cause = Cause.die(cause);
        }
        return failure;
      };
      readCause = (failure) => (#cause in failure ? failure.#cause : undefined);
    }
  }
  const ErrorClass: typeof ActionInvocationPersistenceErrorValue = RetainedError;
  return { createWithCause, ErrorClass, readCause };
})();
const ActionInvocationPersistenceErrorClass = ActionInvocationPersistenceErrorInternals.ErrorClass;
export { ActionInvocationPersistenceErrorClass as ActionInvocationPersistenceError };
// Core-only accessors: deliberately excluded from the package root exports.
export const createActionInvocationPersistenceErrorWithCause =
  ActionInvocationPersistenceErrorInternals.createWithCause;
export const getActionInvocationPersistenceErrorCause = ActionInvocationPersistenceErrorInternals.readCause;

const ActionInvocationNotFoundValue = actionErrorSchema('ActionInvocationNotFound', {
  code: Schema.Literal('action_invocation_not_found'),
  ...safeReason,
});
export type ActionInvocationNotFound = InstanceType<typeof ActionInvocationNotFoundValue>;
export { ActionInvocationNotFoundValue as ActionInvocationNotFound };

const ActionInvocationStateErrorValue = actionErrorSchema('ActionInvocationStateError', {
  code: Schema.Literal('action_invocation_state_invalid'),
  ...safeReason,
});
export type ActionInvocationStateError = InstanceType<typeof ActionInvocationStateErrorValue>;
export { ActionInvocationStateErrorValue as ActionInvocationStateError };

const ActionCollectorErrorValue = actionErrorSchema('ActionCollectorError', {
  code: Schema.Literal('action_collector_invalid'),
  ...safeReason,
});
export type ActionCollectorError = InstanceType<typeof ActionCollectorErrorValue>;
export { ActionCollectorErrorValue as ActionCollectorError };

const ActionHandlerExecutionErrorValue = actionErrorSchema('ActionHandlerExecutionError', {
  code: Schema.Literal('action_handler_execution_failed'),
  ...safeReason,
});
export type ActionHandlerExecutionError = InstanceType<typeof ActionHandlerExecutionErrorValue>;
export { ActionHandlerExecutionErrorValue as ActionHandlerExecutionError };

const ActionPolicyDeniedValue = actionErrorSchema('ActionPolicyDenied', {
  code: Schema.Literal('action_policy_denied'),
  policyReasonCode: Schema.String,
  ...safeReason,
});
export type ActionPolicyDenied = InstanceType<typeof ActionPolicyDeniedValue>;
export { ActionPolicyDeniedValue as ActionPolicyDenied };

const ActionPolicyEvaluationErrorValue = actionErrorSchema('ActionPolicyEvaluationError', {
  code: Schema.Literal('action_policy_evaluation_failed'),
  ...safeReason,
});
export type ActionPolicyEvaluationError = InstanceType<typeof ActionPolicyEvaluationErrorValue>;
export { ActionPolicyEvaluationErrorValue as ActionPolicyEvaluationError };

const ActionCommitIndeterminateValue = actionErrorSchema('ActionCommitIndeterminate', {
  code: Schema.Literal('action_commit_indeterminate'),
  invocationId: ActionInvocationIdSchema,
  ...safeReason,
});
export type ActionCommitIndeterminate = InstanceType<typeof ActionCommitIndeterminateValue>;
export { ActionCommitIndeterminateValue as ActionCommitIndeterminate };

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
