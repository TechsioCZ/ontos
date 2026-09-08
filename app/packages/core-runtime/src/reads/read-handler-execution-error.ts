import { Schema } from 'effect';

export class ReadHandlerExecutionError extends Schema.TaggedError<ReadHandlerExecutionError>()(
  'ReadHandlerExecutionError',
  { code: Schema.Literal('read_handler_execution_failed'), reason: Schema.String },
) {}
