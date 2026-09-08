import { Schema } from 'effect';

export class ReadHandlerNotFound extends Schema.TaggedError<ReadHandlerNotFound>()(
  'ReadHandlerNotFound',
  { code: Schema.Literal('read_handler_not_found'), reason: Schema.String },
) {}
