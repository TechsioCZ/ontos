import type { ModuleStateGateError } from '../modules/module-state-gate-errors.ts';
import type { OperationContextError } from '../operations/errors.ts';
import type { ReadEvidencePersistenceError } from './read-evidence-persistence-error.ts';
import type { ReadEvidenceValidationError } from './read-evidence-validation-error.ts';
import type { ReadHandlerExecutionError } from './read-handler-execution-error.ts';
import type { ReadHandlerNotFound } from './read-handler-not-found.ts';
import type { ReadHandlerUnavailable } from './read-handler-unavailable.ts';
import type { ReadInputValidationError } from './read-input-validation-error.ts';
import type { ReadPermissionDenied } from './read-permission-denied.ts';
import type { ReadPermissionUnavailable } from './read-permission-unavailable.ts';
import type { ReadPolicyDenied } from './read-policy-denied.ts';
import type { ReadPolicyEvaluationError } from './read-policy-evaluation-error.ts';
import type { ReadResultValidationError } from './read-result-validation-error.ts';

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
