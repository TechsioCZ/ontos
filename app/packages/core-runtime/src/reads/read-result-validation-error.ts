import { Schema } from 'effect';

export class ReadResultValidationError extends Schema.TaggedError<ReadResultValidationError>()(
  'ReadResultValidationError',
  { code: Schema.Literal('read_result_invalid'), reason: Schema.String }
) {}
