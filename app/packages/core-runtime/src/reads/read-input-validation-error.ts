import { Schema } from 'effect';

export class ReadInputValidationError extends Schema.TaggedError<ReadInputValidationError>()(
  'ReadInputValidationError',
  { code: Schema.Literal('read_input_invalid'), reason: Schema.String }
) {}
