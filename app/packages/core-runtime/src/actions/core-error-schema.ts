import { Schema } from 'effect';

import { ModuleStateCheckUnavailableError, ModuleStateDeniedError } from '../modules/module-state-gate-errors.ts';
import {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from '../operations/errors.ts';
import {
  ActionAlreadyCommitted,
  ActionCollectorError,
  ActionCommitIndeterminate,
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationNotFound,
  ActionInvocationPersistenceError,
  ActionInvocationStateError,
  ActionPayloadValidationError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPolicyDenied,
  ActionPolicyEvaluationError,
  ActionRequestHashConflict,
  ActionResultValidationError,
  ActionTransactionError,
  ActionTrustedContextValidationError,
} from './errors.ts';
import type { ActionCoreError } from './errors.ts';

/** Lets owner orchestration retain Core failures separately from its declared domain failures. */
export const ActionCoreErrorSchema = Schema.Union([
  ActionAlreadyCommitted,
  ActionCollectorError,
  ActionCommitIndeterminate,
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationNotFound,
  ActionInvocationPersistenceError,
  ActionInvocationStateError,
  ActionPayloadValidationError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPolicyDenied,
  ActionPolicyEvaluationError,
  ActionRequestHashConflict,
  ActionResultValidationError,
  ActionTransactionError,
  ActionTrustedContextValidationError,
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
]) satisfies Schema.ConstraintDecoder<ActionCoreError>;
