import { Schema } from 'effect';

export class OutboxHandlerExecutionError extends Schema.TaggedError<OutboxHandlerExecutionError>()(
  'OutboxHandlerExecutionError',
  { code: Schema.Literal('outbox_handler_execution_failed'), reason: Schema.String },
) {}
