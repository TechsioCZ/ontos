import { Schema } from 'effect';

export class OperationContextUnavailable extends Schema.TaggedError<OperationContextUnavailable>()(
  'OperationContextUnavailable',
  {
    code: Schema.Literal('operation_context_unavailable'),
    reason: Schema.String,
  }
) {}
