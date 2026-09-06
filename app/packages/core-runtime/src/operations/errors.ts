/* eslint-disable max-classes-per-file -- Closed operation-context error vocabulary. */
import { Cause, Schema } from 'effect';

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
) {
  #diagnosticCause: Cause.Cause<never> | undefined;

  static fromCause(reason: string, cause: unknown): OperationContextUnavailable {
    const failure = new OperationContextUnavailable({
      code: 'operation_context_unavailable',
      reason,
    });
    failure.#diagnosticCause = Cause.die(cause);
    return failure;
  }

  /** Internal diagnostics only; excluded from the wire schema and inspection. */
  get diagnosticCause(): Cause.Cause<never> | undefined {
    return this.#diagnosticCause;
  }
}

export type OperationContextError =
  | OperationAuthenticationRequired
  | OperationContextDenied
  | OperationContextInvalid
  | OperationContextUnavailable;
