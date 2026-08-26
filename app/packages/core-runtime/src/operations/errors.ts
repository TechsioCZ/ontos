/* eslint-disable max-classes-per-file -- Closed operation-context error vocabulary. */
import { Schema } from 'effect';

export class OperationAuthenticationRequired extends Schema.TaggedError<OperationAuthenticationRequired>()(
  'OperationAuthenticationRequired',
  { code: Schema.Literal('operation_authentication_required'), reason: Schema.String },
) {}

export class OperationContextDenied extends Schema.TaggedError<OperationContextDenied>()(
  'OperationContextDenied',
  { code: Schema.Literal('operation_context_denied'), reason: Schema.String },
) {}

export class OperationContextInvalid extends Schema.TaggedError<OperationContextInvalid>()(
  'OperationContextInvalid',
  { code: Schema.Literal('operation_context_invalid'), reason: Schema.String },
) {}

export class OperationContextUnavailable extends Schema.TaggedError<OperationContextUnavailable>()(
  'OperationContextUnavailable',
  { code: Schema.Literal('operation_context_unavailable'), reason: Schema.String },
) {}

export type OperationContextError =
  | OperationAuthenticationRequired
  | OperationContextDenied
  | OperationContextInvalid
  | OperationContextUnavailable;
