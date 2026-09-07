import { Schema } from 'effect';

export class OperationContextInvalid extends Schema.TaggedError<OperationContextInvalid>()(
  'OperationContextInvalid',
  { code: Schema.Literal('operation_context_invalid'), reason: Schema.String },
) {}
