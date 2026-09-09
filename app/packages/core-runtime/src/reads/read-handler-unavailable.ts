import { Schema } from 'effect';

export class ReadHandlerUnavailable extends Schema.TaggedError<ReadHandlerUnavailable>()('ReadHandlerUnavailable', {
  code: Schema.Literal('read_handler_unavailable'),
  reason: Schema.String,
}) {}
