/* eslint-disable max-classes-per-file -- The public Core error union is intentionally co-located and exhaustive. */
import { Schema } from 'effect';

const safeReason = {
  reason: Schema.String,
} as const;

export class ActionPayloadValidationError extends Schema.TaggedErrorClass<ActionPayloadValidationError>()(
  'ActionPayloadValidationError',
  {
    code: Schema.Literal('action_payload_invalid'),
    ...safeReason,
  },
) {}

export class ActionResultValidationError extends Schema.TaggedErrorClass<ActionResultValidationError>()(
  'ActionResultValidationError',
  {
    code: Schema.Literal('action_result_invalid'),
    ...safeReason,
  },
) {}

export class ActionTrustedContextValidationError extends Schema.TaggedErrorClass<ActionTrustedContextValidationError>()(
  'ActionTrustedContextValidationError',
  {
    code: Schema.Literal('action_trusted_context_invalid'),
    ...safeReason,
  },
) {}

export class ActionIdempotencyKeyRequired extends Schema.TaggedErrorClass<ActionIdempotencyKeyRequired>()(
  'ActionIdempotencyKeyRequired',
  {
    code: Schema.Literal('action_idempotency_key_required'),
    ...safeReason,
  },
) {}

export class ActionPermissionDenied extends Schema.TaggedErrorClass<ActionPermissionDenied>()(
  'ActionPermissionDenied',
  {
    code: Schema.Literal('action_permission_denied'),
    ...safeReason,
  },
) {}

export class ActionPermissionCheckError extends Schema.TaggedErrorClass<ActionPermissionCheckError>()(
  'ActionPermissionCheckError',
  {
    code: Schema.Literal('action_permission_check_failed'),
    ...safeReason,
  },
) {}

export class ActionAlreadyCommitted extends Schema.TaggedErrorClass<ActionAlreadyCommitted>()(
  'ActionAlreadyCommitted',
  {
    code: Schema.Literal('action_already_committed'),
    ...safeReason,
  },
) {}

export class ActionRequestHashConflict extends Schema.TaggedErrorClass<ActionRequestHashConflict>()(
  'ActionRequestHashConflict',
  {
    code: Schema.Literal('action_request_hash_conflict'),
    ...safeReason,
  },
) {}

export class ActionInvocationPersistenceError extends Schema.TaggedErrorClass<ActionInvocationPersistenceError>()(
  'ActionInvocationPersistenceError',
  {
    code: Schema.Literal('action_invocation_persistence_failed'),
    ...safeReason,
  },
) {}

export class ActionInvocationNotFound extends Schema.TaggedErrorClass<ActionInvocationNotFound>()(
  'ActionInvocationNotFound',
  {
    code: Schema.Literal('action_invocation_not_found'),
    ...safeReason,
  },
) {}

export class ActionInvocationStateError extends Schema.TaggedErrorClass<ActionInvocationStateError>()(
  'ActionInvocationStateError',
  {
    code: Schema.Literal('action_invocation_state_invalid'),
    ...safeReason,
  },
) {}

export class ActionCollectorError extends Schema.TaggedErrorClass<ActionCollectorError>()(
  'ActionCollectorError',
  {
    code: Schema.Literal('action_collector_invalid'),
    ...safeReason,
  },
) {}

export class ActionHandlerExecutionError extends Schema.TaggedErrorClass<ActionHandlerExecutionError>()(
  'ActionHandlerExecutionError',
  {
    code: Schema.Literal('action_handler_execution_failed'),
    ...safeReason,
  },
) {}

export class ActionTransactionError extends Schema.TaggedErrorClass<ActionTransactionError>()(
  'ActionTransactionError',
  {
    code: Schema.Literal('action_transaction_failed'),
    ...safeReason,
  },
) {}

export class ActionCommitIndeterminate extends Schema.TaggedErrorClass<ActionCommitIndeterminate>()(
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
  | ActionRequestHashConflict
  | ActionResultValidationError
  | ActionTransactionError
  | ActionTrustedContextValidationError;

/**
 * Core errors are transport-neutral. A BFF must map this union and the
 * registration's declared domain errors exhaustively to its public schemas.
 * Structural payload/metadata validation maps to 400, invalid trusted
 * authentication context to 401, a missing required idempotency key to 428,
 * permission denial to 403, idempotency and terminal-state conflicts to 409,
 * missing invocations to 404, permission-check failure, temporarily
 * unavailable persistence, and indeterminate commit to 503,
 * and invalid results or sanitized unexpected execution/transaction failures
 * to a declared safe 500.
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
  'ActionTransactionError',
  'ActionCommitIndeterminate',
] as const;
