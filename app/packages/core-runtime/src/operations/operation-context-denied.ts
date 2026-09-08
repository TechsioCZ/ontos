import { Schema } from 'effect';

export class OperationContextDenied extends Schema.TaggedError<OperationContextDenied>()(
  'OperationContextDenied',
  { code: Schema.Literal('operation_context_denied'), reason: Schema.String }
) {}
