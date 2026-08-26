/* eslint-disable max-classes-per-file -- Closed governed-read error vocabulary. */
import { Schema } from 'effect';
import type { OperationContextError } from '../operations/errors.ts';
import type { ModuleStateGateError } from '../modules/module-state-gate-errors.ts';

const reason = { reason: Schema.String } as const;
export class ReadInputValidationError extends Schema.TaggedError<ReadInputValidationError>()(
  'ReadInputValidationError',
  { code: Schema.Literal('read_input_invalid'), ...reason },
) {}
export class ReadResultValidationError extends Schema.TaggedError<ReadResultValidationError>()(
  'ReadResultValidationError',
  { code: Schema.Literal('read_result_invalid'), ...reason },
) {}
export class ReadPermissionDenied extends Schema.TaggedError<ReadPermissionDenied>()(
  'ReadPermissionDenied',
  { code: Schema.Literal('read_permission_denied'), ...reason },
) {}
export class ReadPermissionUnavailable extends Schema.TaggedError<ReadPermissionUnavailable>()(
  'ReadPermissionUnavailable',
  { code: Schema.Literal('read_permission_unavailable'), ...reason },
) {}
export class ReadPolicyDenied extends Schema.TaggedError<ReadPolicyDenied>()('ReadPolicyDenied', {
  code: Schema.Literal('read_policy_denied'),
  httpStatus: Schema.Literals([409, 422]),
  policyReasonCode: Schema.String,
  ...reason,
}) {}
export class ReadPolicyEvaluationError extends Schema.TaggedError<ReadPolicyEvaluationError>()(
  'ReadPolicyEvaluationError',
  { code: Schema.Literal('read_policy_evaluation_failed'), ...reason },
) {}
export class ReadEvidencePersistenceError extends Schema.TaggedError<ReadEvidencePersistenceError>()(
  'ReadEvidencePersistenceError',
  { code: Schema.Literal('read_evidence_persistence_failed'), ...reason },
) {}
export class ReadEvidenceValidationError extends Schema.TaggedError<ReadEvidenceValidationError>()(
  'ReadEvidenceValidationError',
  { code: Schema.Literal('read_evidence_invalid'), ...reason },
) {}
export class ReadHandlerExecutionError extends Schema.TaggedError<ReadHandlerExecutionError>()(
  'ReadHandlerExecutionError',
  { code: Schema.Literal('read_handler_execution_failed'), ...reason },
) {}
export class ReadHandlerUnavailable extends Schema.TaggedError<ReadHandlerUnavailable>()(
  'ReadHandlerUnavailable',
  { code: Schema.Literal('read_handler_unavailable'), ...reason },
) {}
export class ReadHandlerNotFound extends Schema.TaggedError<ReadHandlerNotFound>()(
  'ReadHandlerNotFound',
  { code: Schema.Literal('read_handler_not_found'), ...reason },
) {}

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
