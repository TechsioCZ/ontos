import { Schema } from 'effect';
import { ModuleStateCheckUnavailableError, ModuleStateDeniedError } from '../modules/module-state-gate-errors.ts';
import {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from '../operations/errors.ts';
import { ReadEvidencePersistenceError } from './read-evidence-persistence-error.ts';
import { ReadEvidenceValidationError } from './read-evidence-validation-error.ts';
import { ReadHandlerExecutionError } from './read-handler-execution-error.ts';
import { ReadHandlerNotFound } from './read-handler-not-found.ts';
import { ReadHandlerUnavailable } from './read-handler-unavailable.ts';
import { ReadInputValidationError } from './read-input-validation-error.ts';
import { ReadPermissionDenied } from './read-permission-denied.ts';
import { ReadPermissionUnavailable } from './read-permission-unavailable.ts';
import { ReadPolicyDenied } from './read-policy-denied.ts';
import { ReadPolicyEvaluationError } from './read-policy-evaluation-error.ts';
import { ReadResultValidationError } from './read-result-validation-error.ts';
import type { OperationContextError } from '../operations/errors.ts';
import type { ModuleStateGateError } from '../modules/module-state-gate-errors.ts';

export { ReadEvidencePersistenceError } from './read-evidence-persistence-error.ts';
export { ReadEvidenceValidationError } from './read-evidence-validation-error.ts';
export { ReadHandlerExecutionError } from './read-handler-execution-error.ts';
export { ReadHandlerNotFound } from './read-handler-not-found.ts';
export { ReadHandlerUnavailable } from './read-handler-unavailable.ts';
export { ReadInputValidationError } from './read-input-validation-error.ts';
export { ReadPermissionDenied } from './read-permission-denied.ts';
export { ReadPermissionUnavailable } from './read-permission-unavailable.ts';
export { ReadPolicyDenied } from './read-policy-denied.ts';
export { ReadPolicyEvaluationError } from './read-policy-evaluation-error.ts';
export { ReadResultValidationError } from './read-result-validation-error.ts';

export type ReadCoreError =
  | ModuleStateGateError
  | OperationContextError
  | ReadEvidencePersistenceError
  | ReadEvidenceValidationError
  | ReadHandlerExecutionError
  | ReadHandlerNotFound
  | ReadHandlerUnavailable
  | ReadInputValidationError
  | ReadPermissionDenied
  | ReadPermissionUnavailable
  | ReadPolicyDenied
  | ReadPolicyEvaluationError
  | ReadResultValidationError;

export const ReadCoreErrorSchema = Schema.Union([
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
  ReadEvidencePersistenceError,
  ReadEvidenceValidationError,
  ReadHandlerExecutionError,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  ReadPolicyDenied,
  ReadPolicyEvaluationError,
  ReadResultValidationError,
]);

export const isReadCoreError = Schema.is(ReadCoreErrorSchema);
