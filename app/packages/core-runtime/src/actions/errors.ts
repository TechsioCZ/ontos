import { Cause, Schema } from 'effect';
import type { ActionTransactionError } from './transaction-error.ts';
import type {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
} from '../modules/module-state-gate-errors.ts';
import type { OperationContextError } from '../operations/errors.ts';

export { ActionTransactionError } from './transaction-error.ts';

const safeReason = {
  reason: Schema.String,
} as const;

const ActionInvocationIdSchema = Schema.String.pipe(
  Schema.brand('ActionInvocationId'),
  Schema.decodeTo(Schema.String),
);

const actionPayloadValidationFields = {
  code: Schema.Literal('action_payload_invalid'),
  ...safeReason,
};
const ActionPayloadValidationErrorContract = Schema.TaggedStruct(
  'ActionPayloadValidationError',
  actionPayloadValidationFields,
);
type ActionPayloadValidationErrorSelf = typeof ActionPayloadValidationErrorContract.Type &
  Cause.YieldableError;
const ActionPayloadValidationErrorValue = Schema.TaggedError<ActionPayloadValidationErrorSelf>()(
  'ActionPayloadValidationError',
  actionPayloadValidationFields,
);
export type ActionPayloadValidationError = InstanceType<typeof ActionPayloadValidationErrorValue>;
export { ActionPayloadValidationErrorValue as ActionPayloadValidationError };

const actionResultValidationFields = {
  code: Schema.Literal('action_result_invalid'),
  ...safeReason,
};
const ActionResultValidationErrorContract = Schema.TaggedStruct(
  'ActionResultValidationError',
  actionResultValidationFields,
);
type ActionResultValidationErrorSelf = typeof ActionResultValidationErrorContract.Type &
  Cause.YieldableError;
const ActionResultValidationErrorValue = Schema.TaggedError<ActionResultValidationErrorSelf>()(
  'ActionResultValidationError',
  actionResultValidationFields,
);
export type ActionResultValidationError = InstanceType<typeof ActionResultValidationErrorValue>;
export { ActionResultValidationErrorValue as ActionResultValidationError };

const actionTrustedContextValidationFields = {
  code: Schema.Literal('action_trusted_context_invalid'),
  ...safeReason,
};
const ActionTrustedContextValidationErrorContract = Schema.TaggedStruct(
  'ActionTrustedContextValidationError',
  actionTrustedContextValidationFields,
);
type ActionTrustedContextValidationErrorSelf =
  typeof ActionTrustedContextValidationErrorContract.Type & Cause.YieldableError;
const ActionTrustedContextValidationErrorValue =
  Schema.TaggedError<ActionTrustedContextValidationErrorSelf>()(
    'ActionTrustedContextValidationError',
    actionTrustedContextValidationFields,
  );
export type ActionTrustedContextValidationError = InstanceType<
  typeof ActionTrustedContextValidationErrorValue
>;
export { ActionTrustedContextValidationErrorValue as ActionTrustedContextValidationError };

const actionIdempotencyKeyRequiredFields = {
  code: Schema.Literal('action_idempotency_key_required'),
  ...safeReason,
};
const ActionIdempotencyKeyRequiredContract = Schema.TaggedStruct(
  'ActionIdempotencyKeyRequired',
  actionIdempotencyKeyRequiredFields,
);
type ActionIdempotencyKeyRequiredSelf = typeof ActionIdempotencyKeyRequiredContract.Type &
  Cause.YieldableError;
const ActionIdempotencyKeyRequiredValue = Schema.TaggedError<ActionIdempotencyKeyRequiredSelf>()(
  'ActionIdempotencyKeyRequired',
  actionIdempotencyKeyRequiredFields,
);
export type ActionIdempotencyKeyRequired = InstanceType<typeof ActionIdempotencyKeyRequiredValue>;
export { ActionIdempotencyKeyRequiredValue as ActionIdempotencyKeyRequired };

const actionPermissionDeniedFields = {
  code: Schema.Literal('action_permission_denied'),
  ...safeReason,
};
const ActionPermissionDeniedContract = Schema.TaggedStruct(
  'ActionPermissionDenied',
  actionPermissionDeniedFields,
);
type ActionPermissionDeniedSelf = typeof ActionPermissionDeniedContract.Type & Cause.YieldableError;
const ActionPermissionDeniedValue = Schema.TaggedError<ActionPermissionDeniedSelf>()(
  'ActionPermissionDenied',
  actionPermissionDeniedFields,
);
export type ActionPermissionDenied = InstanceType<typeof ActionPermissionDeniedValue>;
export { ActionPermissionDeniedValue as ActionPermissionDenied };

const actionPermissionCheckFields = {
  code: Schema.Literal('action_permission_check_failed'),
  ...safeReason,
};
const ActionPermissionCheckErrorContract = Schema.TaggedStruct(
  'ActionPermissionCheckError',
  actionPermissionCheckFields,
);
type ActionPermissionCheckErrorSelf = typeof ActionPermissionCheckErrorContract.Type &
  Cause.YieldableError;
const ActionPermissionCheckErrorValue = Schema.TaggedError<ActionPermissionCheckErrorSelf>()(
  'ActionPermissionCheckError',
  actionPermissionCheckFields,
);
export type ActionPermissionCheckError = InstanceType<typeof ActionPermissionCheckErrorValue>;
export { ActionPermissionCheckErrorValue as ActionPermissionCheckError };

const actionAlreadyCommittedFields = {
  code: Schema.Literal('action_already_committed'),
  invocationId: ActionInvocationIdSchema,
  ...safeReason,
};
const ActionAlreadyCommittedContract = Schema.TaggedStruct(
  'ActionAlreadyCommitted',
  actionAlreadyCommittedFields,
);
type ActionAlreadyCommittedSelf = typeof ActionAlreadyCommittedContract.Type & Cause.YieldableError;
const ActionAlreadyCommittedValue = Schema.TaggedError<ActionAlreadyCommittedSelf>()(
  'ActionAlreadyCommitted',
  actionAlreadyCommittedFields,
);
export type ActionAlreadyCommitted = InstanceType<typeof ActionAlreadyCommittedValue>;
export { ActionAlreadyCommittedValue as ActionAlreadyCommitted };

const actionRequestHashConflictFields = {
  code: Schema.Literal('action_request_hash_conflict'),
  ...safeReason,
};
const ActionRequestHashConflictContract = Schema.TaggedStruct(
  'ActionRequestHashConflict',
  actionRequestHashConflictFields,
);
type ActionRequestHashConflictSelf = typeof ActionRequestHashConflictContract.Type &
  Cause.YieldableError;
const ActionRequestHashConflictValue = Schema.TaggedError<ActionRequestHashConflictSelf>()(
  'ActionRequestHashConflict',
  actionRequestHashConflictFields,
);
export type ActionRequestHashConflict = InstanceType<typeof ActionRequestHashConflictValue>;
export { ActionRequestHashConflictValue as ActionRequestHashConflict };

const actionInvocationPersistenceFields = {
  code: Schema.Literal('action_invocation_persistence_failed'),
  ...safeReason,
};
const ActionInvocationPersistenceErrorContract = Schema.TaggedStruct(
  'ActionInvocationPersistenceError',
  actionInvocationPersistenceFields,
);
type ActionInvocationPersistenceErrorSelf = typeof ActionInvocationPersistenceErrorContract.Type &
  Cause.YieldableError;
const ActionInvocationPersistenceErrorValue =
  Schema.TaggedError<ActionInvocationPersistenceErrorSelf>()(
    'ActionInvocationPersistenceError',
    actionInvocationPersistenceFields,
  );
export type ActionInvocationPersistenceError = InstanceType<
  typeof ActionInvocationPersistenceErrorValue
>;
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
export const getActionInvocationPersistenceErrorCause =
  ActionInvocationPersistenceErrorInternals.readCause;

const actionInvocationNotFoundFields = {
  code: Schema.Literal('action_invocation_not_found'),
  ...safeReason,
};
const ActionInvocationNotFoundContract = Schema.TaggedStruct(
  'ActionInvocationNotFound',
  actionInvocationNotFoundFields,
);
type ActionInvocationNotFoundSelf = typeof ActionInvocationNotFoundContract.Type &
  Cause.YieldableError;
const ActionInvocationNotFoundValue = Schema.TaggedError<ActionInvocationNotFoundSelf>()(
  'ActionInvocationNotFound',
  actionInvocationNotFoundFields,
);
export type ActionInvocationNotFound = InstanceType<typeof ActionInvocationNotFoundValue>;
export { ActionInvocationNotFoundValue as ActionInvocationNotFound };

const actionInvocationStateFields = {
  code: Schema.Literal('action_invocation_state_invalid'),
  ...safeReason,
};
const ActionInvocationStateErrorContract = Schema.TaggedStruct(
  'ActionInvocationStateError',
  actionInvocationStateFields,
);
type ActionInvocationStateErrorSelf = typeof ActionInvocationStateErrorContract.Type &
  Cause.YieldableError;
const ActionInvocationStateErrorValue = Schema.TaggedError<ActionInvocationStateErrorSelf>()(
  'ActionInvocationStateError',
  actionInvocationStateFields,
);
export type ActionInvocationStateError = InstanceType<typeof ActionInvocationStateErrorValue>;
export { ActionInvocationStateErrorValue as ActionInvocationStateError };

const actionCollectorFields = {
  code: Schema.Literal('action_collector_invalid'),
  ...safeReason,
};
const ActionCollectorErrorContract = Schema.TaggedStruct(
  'ActionCollectorError',
  actionCollectorFields,
);
type ActionCollectorErrorSelf = typeof ActionCollectorErrorContract.Type & Cause.YieldableError;
const ActionCollectorErrorValue = Schema.TaggedError<ActionCollectorErrorSelf>()(
  'ActionCollectorError',
  actionCollectorFields,
);
export type ActionCollectorError = InstanceType<typeof ActionCollectorErrorValue>;
export { ActionCollectorErrorValue as ActionCollectorError };

const actionHandlerExecutionFields = {
  code: Schema.Literal('action_handler_execution_failed'),
  ...safeReason,
};
const ActionHandlerExecutionErrorContract = Schema.TaggedStruct(
  'ActionHandlerExecutionError',
  actionHandlerExecutionFields,
);
type ActionHandlerExecutionErrorSelf = typeof ActionHandlerExecutionErrorContract.Type &
  Cause.YieldableError;
const ActionHandlerExecutionErrorValue = Schema.TaggedError<ActionHandlerExecutionErrorSelf>()(
  'ActionHandlerExecutionError',
  actionHandlerExecutionFields,
);
export type ActionHandlerExecutionError = InstanceType<typeof ActionHandlerExecutionErrorValue>;
export { ActionHandlerExecutionErrorValue as ActionHandlerExecutionError };

const actionPolicyDeniedFields = {
  code: Schema.Literal('action_policy_denied'),
  policyReasonCode: Schema.String,
  ...safeReason,
};
const ActionPolicyDeniedContract = Schema.TaggedStruct(
  'ActionPolicyDenied',
  actionPolicyDeniedFields,
);
type ActionPolicyDeniedSelf = typeof ActionPolicyDeniedContract.Type & Cause.YieldableError;
const ActionPolicyDeniedValue = Schema.TaggedError<ActionPolicyDeniedSelf>()(
  'ActionPolicyDenied',
  actionPolicyDeniedFields,
);
export type ActionPolicyDenied = InstanceType<typeof ActionPolicyDeniedValue>;
export { ActionPolicyDeniedValue as ActionPolicyDenied };

const actionPolicyEvaluationFields = {
  code: Schema.Literal('action_policy_evaluation_failed'),
  ...safeReason,
};
const ActionPolicyEvaluationErrorContract = Schema.TaggedStruct(
  'ActionPolicyEvaluationError',
  actionPolicyEvaluationFields,
);
type ActionPolicyEvaluationErrorSelf = typeof ActionPolicyEvaluationErrorContract.Type &
  Cause.YieldableError;
const ActionPolicyEvaluationErrorValue = Schema.TaggedError<ActionPolicyEvaluationErrorSelf>()(
  'ActionPolicyEvaluationError',
  actionPolicyEvaluationFields,
);
export type ActionPolicyEvaluationError = InstanceType<typeof ActionPolicyEvaluationErrorValue>;
export { ActionPolicyEvaluationErrorValue as ActionPolicyEvaluationError };

const actionCommitIndeterminateFields = {
  code: Schema.Literal('action_commit_indeterminate'),
  invocationId: ActionInvocationIdSchema,
  ...safeReason,
};
const ActionCommitIndeterminateContract = Schema.TaggedStruct(
  'ActionCommitIndeterminate',
  actionCommitIndeterminateFields,
);
type ActionCommitIndeterminateSelf = typeof ActionCommitIndeterminateContract.Type &
  Cause.YieldableError;
const ActionCommitIndeterminateValue = Schema.TaggedError<ActionCommitIndeterminateSelf>()(
  'ActionCommitIndeterminate',
  actionCommitIndeterminateFields,
);
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
